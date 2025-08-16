import { MarketDataRepository } from './repositories/MarketDataRepository';
import { RedisStreamPublisher } from './messaging/RedisStreamPublisher';
import { ReplaySession } from './models/ReplaySession';
import { ReplayEventType } from './models/ReplayEvent';
import { DataPoint, DataType, ReplayCommand, ReplaySpeed } from './types';
import { Logger } from './utils/Logger';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export class ReplayEngine {
  private logger: Logger;
  private repository: MarketDataRepository;
  private publisher: RedisStreamPublisher;
  private sessions: Map<string, ReplaySession>;
  private eventEmitter: EventEmitter;
  
  constructor(repository: MarketDataRepository, publisher: RedisStreamPublisher) {
    this.logger = new Logger('ReplayEngine');
    this.repository = repository;
    this.publisher = publisher;
    this.sessions = new Map();
    this.eventEmitter = new EventEmitter();
  }
  
  /**
   * Create a new replay session
   */
  public async createSession(options: {
    userId: string;
    instruments: Array<{ venue: string; symbol: string }>;
    startTime: Date;
    endTime: Date;
    speed?: ReplaySpeed;
    initialState?: 'running' | 'paused';
    includeTrades?: boolean;
    includeOrderBooks?: boolean;
    includeL3Data?: boolean;
    includeMarketEvents?: boolean;
    includeNews?: boolean;
  }): Promise<string> {
    try {
      const sessionId = uuidv4();
      
      this.logger.info(`Creating replay session ${sessionId} for user ${options.userId}`);
      
      // Validate time range
      if (options.startTime >= options.endTime) {
        throw new Error('Start time must be before end time');
      }
      
      // Check if data exists for the requested instruments and time range
      for (const instrument of options.instruments) {
        const hasData = await this.repository.hasData(
          instrument.venue,
          instrument.symbol,
          options.startTime,
          options.endTime
        );
        
        if (!hasData) {
          throw new Error(`No data available for ${instrument.venue}:${instrument.symbol} in the specified time range`);
        }
      }
      
      // Create session object
      const session = new ReplaySession({
        id: sessionId,
        userId: options.userId,
        instruments: options.instruments,
        startTime: options.startTime,
        endTime: options.endTime,
        currentTime: options.startTime,
        speed: options.speed || ReplaySpeed.X1,
        state: options.initialState || 'paused',
        dataTypes: {
          trades: options.includeTrades !== false,
          orderBooks: options.includeOrderBooks !== false,
          l3Data: options.includeL3Data || false,
          marketEvents: options.includeMarketEvents || false,
          news: options.includeNews || false
        }
      });
      
      // Store session
      this.sessions.set(sessionId, session);
      
      // If session should start running immediately
      if (options.initialState === 'running') {
        this.startReplay(sessionId);
      }
      
      return sessionId;
    } catch (error) {
      this.logger.error(`Failed to create replay session: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Control a replay session
   */
  public async controlReplay(sessionId: string, command: ReplayCommand): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      this.logger.info(`Received command ${command.type} for session ${sessionId}`);
      
      switch (command.type) {
        case 'start':
          this.startReplay(sessionId);
          break;
          
        case 'pause':
          this.pauseReplay(sessionId);
          break;
          
        case 'resume':
          this.resumeReplay(sessionId);
          break;
          
        case 'stop':
          this.stopReplay(sessionId);
          break;
          
        case 'seek':
          if (command.timestamp) {
            await this.seekReplay(sessionId, new Date(command.timestamp));
          } else {
            throw new Error('Seek command requires a timestamp');
          }
          break;
          
        case 'speed':
          if (command.speed) {
            this.setReplaySpeed(sessionId, command.speed);
          } else {
            throw new Error('Speed command requires a speed value');
          }
          break;
          
        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to control replay session ${sessionId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Start a replay session
   */
  private startReplay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    if (session.state === 'running') {
      this.logger.warn(`Session ${sessionId} is already running`);
      return;
    }
    
    this.logger.info(`Starting replay session ${sessionId}`);
    
    // Set session state to running
    session.state = 'running';
    session.lastTickTime = Date.now();
    
    // Emit session start event
    this.emitSessionEvent(session, ReplayEventType.SESSION_STARTED);
    
    // Start replay loop
    this.replayLoop(session);
  }
  
  /**
   * Pause a replay session
   */
  private pauseReplay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    if (session.state !== 'running') {
      this.logger.warn(`Session ${sessionId} is not running`);
      return;
    }
    
    this.logger.info(`Pausing replay session ${sessionId}`);
    
    // Set session state to paused
    session.state = 'paused';
    
    // Emit session pause event
    this.emitSessionEvent(session, ReplayEventType.SESSION_PAUSED);
  }
  
  /**
   * Resume a paused replay session
   */
  private resumeReplay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    if (session.state !== 'paused') {
      this.logger.warn(`Session ${sessionId} is not paused`);
      return;
    }
    
    this.logger.info(`Resuming replay session ${sessionId}`);
    
    // Set session state to running
    session.state = 'running';
    session.lastTickTime = Date.now();
    
    // Emit session resume event
    this.emitSessionEvent(session, ReplayEventType.SESSION_RESUMED);
    
    // Continue replay loop
    this.replayLoop(session);
  }
  
  /**
   * Stop a replay session
   */
  private stopReplay(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    this.logger.info(`Stopping replay session ${sessionId}`);
    
    // Set session state to stopped
    session.state = 'stopped';
    
    // Emit session stop event
    this.emitSessionEvent(session, ReplayEventType.SESSION_STOPPED);
    
    // Remove session after a delay to allow clients to receive the stopped event
    setTimeout(() => {
      this.sessions.delete(sessionId);
      this.logger.info(`Removed session ${sessionId}`);
    }, 5000);
  }
  
  /**
   * Seek to a specific time in the replay
   */
  private async seekReplay(sessionId: string, timestamp: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    // Validate timestamp is within session range
    if (timestamp < session.startTime || timestamp > session.endTime) {
      throw new Error(`Timestamp ${timestamp.toISOString()} is outside session time range`);
    }
    
    this.logger.info(`Seeking session ${sessionId} to ${timestamp.toISOString()}`);
    
    const wasPaused = session.state !== 'running';
    
    // Pause if running
    if (!wasPaused) {
      session.state = 'paused';
    }
    
    // Update current time
    session.currentTime = new Date(timestamp);
    
    // Emit seek event
    this.emitSessionEvent(session, ReplayEventType.SESSION_SEEKED, { timestamp });
    
    // If session was running before, resume it
    if (!wasPaused) {
      session.state = 'running';
      session.lastTickTime = Date.now();
      this.replayLoop(session);
    }
  }
  
  /**
   * Set replay speed
   */
  private setReplaySpeed(sessionId: string, speed: ReplaySpeed): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    this.logger.info(`Setting speed for session ${sessionId} to ${speed}`);
    
    // Update session speed
    session.speed = speed;
    
    // Reset last tick time to avoid jumps
    session.lastTickTime = Date.now();
    
    // Emit speed change event
    this.emitSessionEvent(session, ReplayEventType.SPEED_CHANGED, { speed });
  }
  
  /**
   * Main replay loop
   */
  private async replayLoop(session: ReplaySession): Promise<void> {
    // Exit if session is no longer running
    if (session.state !== 'running') {
      return;
    }
    
    try {
      // Calculate how much simulated time has passed
      const now = Date.now();
      const realTimeDelta = now - session.lastTickTime;
      const simulatedTimeDelta = realTimeDelta * this.getSpeedMultiplier(session.speed);
      
      // Update session time
      const newTime = new Date(session.currentTime.getTime() + simulatedTimeDelta);
      
      // Check if we've reached the end of the session
      if (newTime >= session.endTime) {
        this.logger.info(`Session ${session.id} reached end time`);
        session.currentTime = new Date(session.endTime);
        
        // Emit session complete event
        this.emitSessionEvent(session, ReplayEventType.SESSION_COMPLETED);
        
        // Stop the session
        this.stopReplay(session.id);
        return;
      }
      
      // Update current time and last tick time
      session.currentTime = newTime;
      session.lastTickTime = now;
      
      // Fetch data for the current time window
      const data = await this.fetchDataForTimeWindow(
        session,
        session.currentTime,
        new Date(session.currentTime.getTime() + simulatedTimeDelta)
      );
      
      // Publish data to clients
      if (data.length > 0) {
        await this.publishData(session, data);
      }
      
      // Emit time update event (less frequently to reduce overhead)
      if (now - (session.lastTimeUpdateEvent || 0) > 500) {
        this.emitSessionEvent(session, ReplayEventType.TIME_UPDATED, {
          currentTime: session.currentTime.toISOString()
        });
        session.lastTimeUpdateEvent = now;
      }
      
      // Schedule next tick - use setTimeout for slower speeds, requestAnimationFrame for faster
      if (session.speed <= ReplaySpeed.X1) {
        setTimeout(() => this.replayLoop(session), 100);
      } else {
        requestAnimationFrame(() => this.replayLoop(session));
      }
    } catch (error) {
      this.logger.error(`Error in replay loop for session ${session.id}: ${error.message}`);
      
      // Pause the session on error
      this.pauseReplay(session.id);
      
      // Emit error event
      this.emitSessionEvent(session, ReplayEventType.SESSION_ERROR, {
        error: error.message
      });
    }
  }
  
  /**
   * Fetch data for a time window
   */
  private async fetchDataForTimeWindow(
    session: ReplaySession,
    startTime: Date,
    endTime: Date
  ): Promise<DataPoint[]> {
    const data: DataPoint[] = [];
    
    // Fetch data for each instrument and data type
    for (const instrument of session.instruments) {
      // Fetch trades if enabled
      if (session.dataTypes.trades) {
        const trades = await this.repository.getTrades(
          instrument.venue,
          instrument.symbol,
          startTime,
          endTime
        );
        
        data.push(...trades.map(trade => ({
          ...trade,
          dataType: DataType.TRADE
        })));
      }
      
      // Fetch order books if enabled
      if (session.dataTypes.orderBooks) {
        const orderBooks = await this.repository.getOrderBooks(
          instrument.venue,
          instrument.symbol,
          startTime,
          endTime
        );
        
        data.push(...orderBooks.map(ob => ({
          ...ob,
          dataType: DataType.ORDER_BOOK
        })));
      }
      
      // Fetch L3 data if enabled
      if (session.dataTypes.l3Data) {
        const l3Data = await this.repository.getL3Data(
          instrument.venue,
          instrument.symbol,
          startTime,
          endTime
        );
        
        data.push(...l3Data.map(l3 => ({
          ...l3,
          dataType: DataType.L3_DATA
        })));
      }
      
      // Fetch market events if enabled
      if (session.dataTypes.marketEvents) {
        const events = await this.repository.getMarketEvents(
          instrument.venue,
          instrument.symbol,
          startTime,
          endTime
        );
        
        data.push(...events.map(event => ({
          ...event,
          dataType: DataType.MARKET_EVENT
        })));
      }
    }
    
    // Fetch news if enabled
    if (session.dataTypes.news) {
      const news = await this.repository.getNews(startTime, endTime);
      
      data.push(...news.map(item => ({
        ...item,
        dataType: DataType.NEWS
      })));
    }
    
    // Sort all data by timestamp
    data.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    return data;
  }
  
  /**
   * Publish data to clients
   */
  private async publishData(session: ReplaySession, data: DataPoint[]): Promise<void> {
    // Group data by type for more efficient publishing
    const dataByType = data.reduce((acc, item) => {
      if (!acc[item.dataType]) {
        acc[item.dataType] = [];
      }
      acc[item.dataType].push(item);
      return acc;
    }, {} as Record<DataType, DataPoint[]>);
    
    // Publish each data type to its own channel
    for (const [dataType, items] of Object.entries(dataByType)) {
      if (items.length === 0) continue;
      
      const channel = `replay:${session.id}:${dataType}`;
      
      // Add session ID and replay flag to each item
      const enrichedItems = items.map(item => ({
        ...item,
        sessionId: session.id,
        isReplay: true
      }));
      
      // Publish to Redis stream
      await this.publisher.publish(channel, enrichedItems);
    }
  }
  
  /**
   * Convert replay speed to a time multiplier
   */
  private getSpeedMultiplier(speed: ReplaySpeed): number {
    switch (speed) {
      case ReplaySpeed.X0_25:
        return 0.25;
      case ReplaySpeed.X0_5:
        return 0.5;
      case ReplaySpeed.X1:
        return 1;
      case ReplaySpeed.X2:
        return 2;
      case ReplaySpeed.X4:
        return 4;
      case ReplaySpeed.X8:
        return 8;
      case ReplaySpeed.X16:
        return 16;
      case ReplaySpeed.X32:
        return 32;
      case ReplaySpeed.X64:
        return 64;
      default:
        return 1;
    }
  }
  
  /**
   * Emit session event
   */
  private emitSessionEvent(
    session: ReplaySession,
    eventType: ReplayEventType,
    data: Record<string, any> = {}
  ): void {
    const event = {
      sessionId: session.id,
      userId: session.userId,
      type: eventType,
      timestamp: new Date().toISOString(),
      data: {
        ...data,
        currentTime: session.currentTime.toISOString(),
        speed: session.speed,
        state: session.state
      }
    };
    
    // Emit locally
    this.eventEmitter.emit(`session:${session.id}`, event);
    this.eventEmitter.emit('session:event', event);
    
    // Publish to Redis for clients
    this.publisher.publish(`replay:${session.id}:events`, event);
  }
  
  /**
   * Subscribe to session events
   */
  public onSessionEvent(
    sessionId: string | null,
    callback: (event: any) => void
  ): () => void {
    const eventName = sessionId ? `session:${sessionId}` : 'session:event';
    
    this.eventEmitter.on(eventName, callback);
    
    // Return unsubscribe function
    return () => {
      this.eventEmitter.off(eventName, callback);
    };
  }
  
  /**
   * Get active session
   */
  public getSession(sessionId: string): ReplaySession | undefined {
    return this.sessions.get(sessionId);
  }
  
  /**
   * Get all active sessions
   */
  public getAllSessions(): ReplaySession[] {
    return Array.from(this.sessions.values());
  }
  
  /**
   * Get active sessions for user
   */
  public getUserSessions(userId: string): ReplaySession[] {
    return Array.from(this.sessions.values()).filter(
      session => session.userId === userId
    );
  }
}