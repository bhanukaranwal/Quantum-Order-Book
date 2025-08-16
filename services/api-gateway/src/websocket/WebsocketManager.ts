import WebSocket from 'ws';
import http from 'http';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { verify, JsonWebTokenError } from 'jsonwebtoken';
import { Logger } from '../utils/Logger';
import { EventEmitter } from '../events/EventEmitter';
import { TokenService } from '../services/TokenService';
import { MetricsService } from '../services/MetricsService';

/**
 * WebSocket client connection
 */
interface WebSocketClient {
  id: string;
  socket: WebSocket;
  isAlive: boolean;
  userId?: string;
  isAuthenticated: boolean;
  subscriptions: Set<string>;
  ipAddress: string;
  userAgent: string;
  connectedAt: number;
  lastMessageAt: number;
  lastPingAt: number;
  messageCount: number;
  authenticated?: {
    userId: string;
    username: string;
    tier: string;
  };
}

/**
 * WebSocket message
 */
interface WebSocketMessage {
  type: string;
  id?: string;
  channel?: string;
  data?: any;
  error?: string;
}

/**
 * WebSocket message handler
 */
type MessageHandler = (
  client: WebSocketClient,
  message: WebSocketMessage
) => Promise<void>;

/**
 * Websocket rate limit configuration
 */
interface WebsocketRateLimit {
  messagesPerSecond: number;
  subscriptionsPerClient: number;
  maxClients: number;
  reconnectDelayMs: number;
}

/**
 * WebSocket manager for handling real-time communications
 */
export class WebsocketManager {
  private wss: WebSocket.Server;
  private clients: Map<string, WebSocketClient> = new Map();
  private handlers: Map<string, MessageHandler> = new Map();
  private channelSubscriptions: Map<string, Set<string>> = new Map();
  private userConnections: Map<string, Set<string>> = new Map();
  private rateLimits: Map<string, WebsocketRateLimit> = new Map();
  private rateLimitCounters: Map<string, number> = new Map();
  private logger: Logger;
  private redis: Redis;
  private tokenService: TokenService;
  private eventEmitter: EventEmitter;
  private metricsService: MetricsService;
  private pingInterval: NodeJS.Timeout | null = null;
  private defaultRateLimit: WebsocketRateLimit = {
    messagesPerSecond: 10,
    subscriptionsPerClient: 50,
    maxClients: 10000,
    reconnectDelayMs: 1000
  };
  
  constructor(
    server: http.Server,
    logger: Logger,
    redis: Redis,
    tokenService: TokenService,
    eventEmitter: EventEmitter,
    metricsService: MetricsService
  ) {
    this.logger = logger;
    this.redis = redis;
    this.tokenService = tokenService;
    this.eventEmitter = eventEmitter;
    this.metricsService = metricsService;
    
    // Create WebSocket server
    this.wss = new WebSocket.Server({ 
      server,
      perMessageDeflate: true,
      maxPayload: 1024 * 1024 // 1MB max message size
    });
    
    // Configure default rate limits for different user tiers
    this.initializeRateLimits();
    
    // Set up event handlers
    this.setupEventHandlers();
    
    // Register message handlers
    this.registerMessageHandlers();
    
    // Start ping interval
    this.startPingInterval();
    
    // Subscribe to system events
    this.subscribeToEvents();
  }
  
  /**
   * Initialize the WebSocket server
   */
  public initialize(): void {
    this.logger.info('WebSocket server initialized');
  }
  
  /**
   * Shutdown the WebSocket server
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down WebSocket server');
    
    // Stop ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // Send close message to all clients
    for (const client of this.clients.values()) {
      try {
        client.socket.send(JSON.stringify({
          type: 'system',
          data: { message: 'Server shutting down' }
        }));
        
        client.socket.close(1001, 'Server shutting down');
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
    
    // Close WebSocket server
    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.logger.info('WebSocket server closed');
        resolve();
      });
    });
  }
  
  /**
   * Get connected client count
   */
  public getClientCount(): number {
    return this.clients.size;
  }
  
  /**
   * Get authenticated client count
   */
  public getAuthenticatedClientCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.isAuthenticated) {
        count++;
      }
    }
    return count;
  }
  
  /**
   * Get subscription count for a channel
   */
  public getChannelSubscriptionCount(channel: string): number {
    const subscribers = this.channelSubscriptions.get(channel);
    return subscribers ? subscribers.size : 0;
  }
  
  /**
   * Get all active channels with subscriber counts
   */
  public getActiveChannels(): Array<{ channel: string; subscribers: number }> {
    const channels: Array<{ channel: string; subscribers: number }> = [];
    
    for (const [channel, subscribers] of this.channelSubscriptions.entries()) {
      if (subscribers.size > 0) {
        channels.push({
          channel,
          subscribers: subscribers.size
        });
      }
    }
    
    return channels;
  }
  
  /**
   * Broadcast message to all clients subscribed to a channel
   */
  public broadcastToChannel(channel: string, message: any): void {
    const subscribers = this.channelSubscriptions.get(channel);
    if (!subscribers || subscribers.size === 0) return;
    
    const messageJson = JSON.stringify({
      type: 'message',
      channel,
      data: message
    });
    
    let sentCount = 0;
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(messageJson);
          sentCount++;
        } catch (error) {
          this.logger.error('Error sending message to client', {
            error,
            clientId,
            channel
          });
        }
      }
    }
    
    // Record metrics
    this.metricsService.recordChannelBroadcast(channel, sentCount);
    
    this.logger.debug(`Broadcast message to ${sentCount} clients on channel ${channel}`);
  }
  
  /**
   * Send message to a specific client
   */
  public sendToClient(clientId: string, message: any): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    try {
      client.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error('Error sending message to client', {
        error,
        clientId
      });
      return false;
    }
  }
  
  /**
   * Send message to a specific user (all connections)
   */
  public sendToUser(userId: string, message: any): number {
    const clientIds = this.userConnections.get(userId);
    if (!clientIds || clientIds.size === 0) {
      return 0;
    }
    
    const messageJson = JSON.stringify(message);
    let sentCount = 0;
    
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(messageJson);
          sentCount++;
        } catch (error) {
          this.logger.error('Error sending message to user', {
            error,
            userId,
            clientId
          });
        }
      }
    }
    
    return sentCount;
  }
  
  /**
   * Kick a client
   */
  public kickClient(clientId: string, reason: string = 'Kicked by system'): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }
    
    try {
      // Send kick message
      client.socket.send(JSON.stringify({
        type: 'system',
        data: { message: reason }
      }));
      
      // Close connection
      client.socket.close(1000, reason);
      
      // Remove client
      this.removeClient(client);
      
      this.logger.info('Client kicked', { clientId, reason });
      
      return true;
    } catch (error) {
      this.logger.error('Error kicking client', {
        error,
        clientId,
        reason
      });
      return false;
    }
  }
  
  /**
   * Kick all connections for a user
   */
  public kickUser(userId: string, reason: string = 'Kicked by system'): number {
    const clientIds = this.userConnections.get(userId);
    if (!clientIds || clientIds.size === 0) {
      return 0;
    }
    
    let kickedCount = 0;
    for (const clientId of clientIds) {
      if (this.kickClient(clientId, reason)) {
        kickedCount++;
      }
    }
    
    return kickedCount;
  }
  
  /**
   * Set up WebSocket server event handlers
   */
  private setupEventHandlers(): void {
    // Handle new connections
    this.wss.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
      this.handleNewConnection(socket, request);
    });
    
    // Handle server errors
    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error', { error });
    });
    
    // Log server listening
    this.wss.on('listening', () => {
      this.logger.info('WebSocket server listening');
    });
  }
  
  /**
   * Handle new WebSocket connection
   */
  private handleNewConnection(socket: WebSocket, request: http.IncomingMessage): void {
    // Check maximum connections limit
    if (this.clients.size >= this.defaultRateLimit.maxClients) {
      socket.close(1013, 'Maximum connections reached');
      this.logger.warn('Connection rejected due to maximum connections limit');
      return;
    }
    
    // Create client ID
    const clientId = uuidv4();
    
    // Get client IP
    const ip = this.getClientIp(request);
    
    // Get user agent
    const userAgent = request.headers['user-agent'] || 'Unknown';
    
    // Create client object
    const client: WebSocketClient = {
      id: clientId,
      socket,
      isAlive: true,
      isAuthenticated: false,
      subscriptions: new Set(),
      ipAddress: ip,
      userAgent,
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      lastPingAt: Date.now(),
      messageCount: 0
    };
    
    // Add client to the map
    this.clients.set(clientId, client);
    
    // Record connection metrics
    this.metricsService.recordWebsocketConnection();
    
    // Try to authenticate from query parameters
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    const token = url.searchParams.get('token') || url.searchParams.get('access_token');
    
    if (token) {
      this.authenticateClient(client, token)
        .catch(error => {
          this.logger.debug('Authentication from URL token failed', {
            error: error.message,
            clientId
          });
        });
    }
    
    this.logger.debug('New WebSocket connection', {
      clientId,
      ip,
      userAgent
    });
    
    // Send welcome message
    socket.send(JSON.stringify({
      type: 'system',
      data: {
        message: 'Welcome to Quantum Order Book WebSocket API',
        clientId
      }
    }));
    
    // Handle messages
    socket.on('message', (data: WebSocket.Data) => {
      this.handleClientMessage(client, data);
    });
    
    // Handle connection close
    socket.on('close', (code: number, reason: string) => {
      this.handleClientDisconnect(client, code, reason);
    });
    
    // Handle errors
    socket.on('error', (error) => {
      this.logger.error('WebSocket client error', {
        error,
        clientId,
        ip
      });
    });
    
    // Handle pong response
    socket.on('pong', () => {
      client.isAlive = true;
      client.lastPingAt = Date.now();
    });
  }
  
  /**
   * Handle client message
   */
  private async handleClientMessage(client: WebSocketClient, data: WebSocket.Data): Promise<void> {
    // Update last message time
    client.lastMessageAt = Date.now();
    client.messageCount++;
    
    // Check rate limit
    if (!this.checkRateLimit(client)) {
      client.socket.send(JSON.stringify({
        type: 'error',
        error: 'Rate limit exceeded'
      }));
      return;
    }
    
    // Record metrics
    this.metricsService.recordWebsocketMessage();
    
    try {
      // Parse message
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      
      // Validate message
      if (!message.type) {
        throw new Error('Message type is required');
      }
      
      // Handle message by type
      const handler = this.handlers.get(message.type);
      if (handler) {
        await handler(client, message);
      } else {
        throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      this.logger.debug('Invalid WebSocket message', {
        error: error.message,
        clientId: client.id,
        data: typeof data === 'string' ? data : 'binary data'
      });
      
      // Send error response
      client.socket.send(JSON.stringify({
        type: 'error',
        error: error.message
      }));
    }
  }
  
  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(client: WebSocketClient, code: number, reason: string): void {
    this.logger.debug('WebSocket client disconnected', {
      clientId: client.id,
      code,
      reason: reason || 'No reason provided',
      authenticated: client.isAuthenticated,
      subscriptions: client.subscriptions.size,
      connectionDuration: Date.now() - client.connectedAt
    });
    
    // Record disconnect metrics
    this.metricsService.recordWebsocketDisconnection();
    
    // Remove client
    this.removeClient(client);
  }
  
  /**
   * Remove client and clean up subscriptions
   */
  private removeClient(client: WebSocketClient): void {
    // Remove from user connections map
    if (client.authenticated) {
      const userId = client.authenticated.userId;
      const userClients = this.userConnections.get(userId);
      
      if (userClients) {
        userClients.delete(client.id);
        
        if (userClients.size === 0) {
          this.userConnections.delete(userId);
        }
      }
    }
    
    // Remove from channel subscriptions
    for (const channel of client.subscriptions) {
      const subscribers = this.channelSubscriptions.get(channel);
      
      if (subscribers) {
        subscribers.delete(client.id);
        
        if (subscribers.size === 0) {
          this.channelSubscriptions.delete(channel);
        }
      }
    }
    
    // Remove from clients map
    this.clients.delete(client.id);
  }
  
  /**
   * Start ping interval to keep connections alive and detect dead clients
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      this.performPingCheck();
    }, 30000); // Check every 30 seconds
  }
  
  /**
   * Perform ping check on all clients
   */
  private performPingCheck(): void {
    const now = Date.now();
    const deadClients: WebSocketClient[] = [];
    
    for (const client of this.clients.values()) {
      // Check if client hasn't responded to previous ping
      if (!client.isAlive) {
        deadClients.push(client);
        continue;
      }
      
      // Mark as not alive, will be set to true when pong is received
      client.isAlive = false;
      
      // Send ping
      try {
        client.socket.ping();
      } catch (error) {
        deadClients.push(client);
      }
      
      // Check for inactive clients (no messages for 10 minutes)
      const inactiveTime = now - client.lastMessageAt;
      if (inactiveTime > 10 * 60 * 1000) {
        this.logger.debug('Closing inactive client connection', {
          clientId: client.id,
          inactiveTime: Math.floor(inactiveTime / 1000)
        });
        
        deadClients.push(client);
      }
    }
    
    // Terminate dead connections
    for (const client of deadClients) {
      try {
        client.socket.terminate();
        this.removeClient(client);
      } catch (error) {
        this.logger.error('Error terminating dead client', {
          error,
          clientId: client.id
        });
      }
    }
    
    if (deadClients.length > 0) {
      this.logger.debug(`Removed ${deadClients.length} dead clients`);
    }
    
    // Reset rate limit counters periodically
    this.rateLimitCounters.clear();
    
    // Record metrics
    this.metricsService.gaugeWebsocketConnections(this.clients.size);
    this.metricsService.gaugeWebsocketAuthenticatedConnections(this.getAuthenticatedClientCount());
  }
  
  /**
   * Register message handlers
   */
  private registerMessageHandlers(): void {
    // Authentication handler
    this.handlers.set('auth', async (client, message) => {
      if (!message.data || !message.data.token) {
        throw new Error('Token is required for authentication');
      }
      
      await this.authenticateClient(client, message.data.token);
      
      // Send success response
      client.socket.send(JSON.stringify({
        type: 'auth',
        id: message.id,
        data: {
          authenticated: true,
          userId: client.authenticated!.userId,
          username: client.authenticated!.username
        }
      }));
    });
    
    // Subscribe handler
    this.handlers.set('subscribe', async (client, message) => {
      if (!message.channel) {
        throw new Error('Channel is required for subscription');
      }
      
      // Check if channel requires authentication
      if (this.isProtectedChannel(message.channel) && !client.isAuthenticated) {
        throw new Error('Authentication required for this channel');
      }
      
      // Check subscription limit
      const tierLimit = this.getRateLimitForClient(client);
      if (client.subscriptions.size >= tierLimit.subscriptionsPerClient) {
        throw new Error(`Maximum subscriptions limit (${tierLimit.subscriptionsPerClient}) reached`);
      }
      
      // Add to client subscriptions
      client.subscriptions.add(message.channel);
      
      // Add to channel subscriptions
      let subscribers = this.channelSubscriptions.get(message.channel);
      if (!subscribers) {
        subscribers = new Set();
        this.channelSubscriptions.set(message.channel, subscribers);
      }
      subscribers.add(client.id);
      
      // Send success response
      client.socket.send(JSON.stringify({
        type: 'subscribed',
        id: message.id,
        channel: message.channel
      }));
      
      this.logger.debug('Client subscribed to channel', {
        clientId: client.id,
        channel: message.channel,
        subscriptionCount: client.subscriptions.size
      });
    });
    
    // Unsubscribe handler
    this.handlers.set('unsubscribe', async (client, message) => {
      if (!message.channel) {
        throw new Error('Channel is required for unsubscription');
      }
      
      // Remove from client subscriptions
      client.subscriptions.delete(message.channel);
      
      // Remove from channel subscriptions
      const subscribers = this.channelSubscriptions.get(message.channel);
      if (subscribers) {
        subscribers.delete(client.id);
        
        if (subscribers.size === 0) {
          this.channelSubscriptions.delete(message.channel);
        }
      }
      
      // Send success response
      client.socket.send(JSON.stringify({
        type: 'unsubscribed',
        id: message.id,
        channel: message.channel
      }));
      
      this.logger.debug('Client unsubscribed from channel', {
        clientId: client.id,
        channel: message.channel,
        subscriptionCount: client.subscriptions.size
      });
    });
    
    // Ping handler
    this.handlers.set('ping', async (client, message) => {
      client.socket.send(JSON.stringify({
        type: 'pong',
        id: message.id,
        data: {
          timestamp: Date.now()
        }
      }));
    });
  }
  
  /**
   * Authenticate a client using token
   */
  private async authenticateClient(client: WebSocketClient, token: string): Promise<void> {
    try {
      // Verify token
      const payload = await this.tokenService.verifyAccessToken(token);
      
      // Check if already authenticated as different user
      if (client.isAuthenticated && client.authenticated!.userId !== payload.userId) {
        throw new Error('Already authenticated as a different user');
      }
      
      // Update client with authentication info
      client.isAuthenticated = true;
      client.authenticated = {
        userId: payload.userId,
        username: payload.username,
        tier: payload.tier || 'free'
      };
      
      // Add to user connections map
      let userClients = this.userConnections.get(payload.userId);
      if (!userClients) {
        userClients = new Set();
        this.userConnections.set(payload.userId, userClients);
      }
      userClients.add(client.id);
      
      this.logger.debug('Client authenticated', {
        clientId: client.id,
        userId: payload.userId,
        username: payload.username,
        tier: payload.tier || 'free'
      });
    } catch (error) {
      if (error instanceof JsonWebTokenError) {
        throw new Error('Invalid authentication token');
      }
      throw error;
    }
  }
  
  /**
   * Check if a channel requires authentication
   */
  private isProtectedChannel(channel: string): boolean {
    // Channels requiring authentication
    const protectedPrefixes = [
      'user.',
      'account.',
      'orders.',
      'private.'
    ];
    
    return protectedPrefixes.some(prefix => channel.startsWith(prefix));
  }
  
  /**
   * Check rate limit for a client
   */
  private checkRateLimit(client: WebSocketClient): boolean {
    const clientKey = `${client.id}:message`;
    
    // Get current rate limit counter
    let counter = this.rateLimitCounters.get(clientKey) || 0;
    counter++;
    
    // Store updated counter
    this.rateLimitCounters.set(clientKey, counter);
    
    // Get appropriate rate limit
    const limit = this.getRateLimitForClient(client);
    
    // Check if limit is exceeded
    if (counter > limit.messagesPerSecond) {
      this.logger.warn('Client exceeded message rate limit', {
        clientId: client.id,
        counter,
        limit: limit.messagesPerSecond
      });
      return false;
    }
    
    return true;
  }
  
  /**
   * Get rate limit for a client based on their tier
   */
  private getRateLimitForClient(client: WebSocketClient): WebsocketRateLimit {
    if (!client.isAuthenticated) {
      return this.rateLimits.get('anonymous') || this.defaultRateLimit;
    }
    
    const tier = client.authenticated!.tier;
    return this.rateLimits.get(tier) || this.defaultRateLimit;
  }
  
  /**
   * Get client IP address
   */
  private getClientIp(request: http.IncomingMessage): string {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ips.split(',')[0].trim();
    }
    
    return (request.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }
  
  /**
   * Initialize rate limits for different user tiers
   */
  private initializeRateLimits(): void {
    // Anonymous users
    this.rateLimits.set('anonymous', {
      messagesPerSecond: 5,
      subscriptionsPerClient: 10,
      maxClients: 10000,
      reconnectDelayMs: 1000
    });
    
    // Free tier
    this.rateLimits.set('free', {
      messagesPerSecond: 10,
      subscriptionsPerClient: 20,
      maxClients: 10000,
      reconnectDelayMs: 1000
    });
    
    // Premium tier
    this.rateLimits.set('premium', {
      messagesPerSecond: 30,
      subscriptionsPerClient: 50,
      maxClients: 10000,
      reconnectDelayMs: 500
    });
    
    // Enterprise tier
    this.rateLimits.set('enterprise', {
      messagesPerSecond: 100,
      subscriptionsPerClient: 200,
      maxClients: 10000,
      reconnectDelayMs: 100
    });
  }
  
  /**
   * Subscribe to system events
   */
  private subscribeToEvents(): void {
    // Subscribe to user logout events
    this.eventEmitter.on('user:logout', (data: { userId: string }) => {
      this.kickUser(data.userId, 'Logged out from another session');
    });
    
    // Subscribe to user account suspension events
    this.eventEmitter.on('user:suspended', (data: { userId: string }) => {
      this.kickUser(data.userId, 'Account suspended');
    });
    
    // Subscribe to broadcast events
    this.eventEmitter.on('broadcast:channel', (data: { channel: string; message: any }) => {
      this.broadcastToChannel(data.channel, data.message);
    });
    
    // Subscribe to user message events
    this.eventEmitter.on('message:user', (data: { userId: string; message: any }) => {
      this.sendToUser(data.userId, data.message);
    });
  }
}