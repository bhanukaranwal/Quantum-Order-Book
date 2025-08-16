import WebSocket from 'ws';
import { Logger } from '../utils/Logger';
import { VenueAdapter } from './adapters/VenueAdapter';
import { BinanceAdapter } from './adapters/BinanceAdapter';
import { CoinbaseAdapter } from './adapters/CoinbaseAdapter';
import { KrakenAdapter } from './adapters/KrakenAdapter';
import { DataNormalizer } from '../normalization/DataNormalizer';
import { RedisPublisher } from '../messaging/RedisPublisher';

interface WebSocketConnection {
  venue: string;
  symbol: string;
  ws: WebSocket;
  adapter: VenueAdapter;
  isConnected: boolean;
  reconnectAttempts: number;
}

export class WebSocketManager {
  private connections: Map<string, WebSocketConnection> = new Map();
  private normalizer: DataNormalizer;
  private publisher: RedisPublisher;
  private logger: Logger;
  
  constructor(normalizer: DataNormalizer, publisher: RedisPublisher) {
    this.normalizer = normalizer;
    this.publisher = publisher;
    this.logger = new Logger('WebSocketManager');
  }
  
  public async subscribeToOrderBook(venue: string, symbol: string): Promise<boolean> {
    const connectionKey = `${venue}:${symbol}`;
    
    if (this.connections.has(connectionKey)) {
      this.logger.info(`Already subscribed to ${connectionKey}`);
      return true;
    }
    
    try {
      const adapter = this.getAdapterForVenue(venue);
      const url = adapter.getWebSocketUrl(symbol);
      
      const ws = new WebSocket(url);
      
      const connection: WebSocketConnection = {
        venue,
        symbol,
        ws,
        adapter,
        isConnected: false,
        reconnectAttempts: 0
      };
      
      ws.on('open', () => {
        this.logger.info(`Connected to ${venue} for ${symbol}`);
        connection.isConnected = true;
        connection.reconnectAttempts = 0;
        
        // Send subscription message
        const subscriptionMsg = adapter.getOrderBookSubscriptionMessage(symbol);
        ws.send(JSON.stringify(subscriptionMsg));
      });
      
      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Check if it's a heartbeat or system message
          if (adapter.isHeartbeatMessage(message)) {
            return;
          }
          
          // Normalize the data
          const normalized = adapter.normalizeOrderBookData(message);
          if (normalized) {
            // Further processing through the normalization pipeline
            const enriched = this.normalizer.process(normalized);
            
            // Publish to the message bus
            this.publisher.publishOrderBookUpdate(venue, symbol, enriched);
          }
        } catch (err) {
          this.logger.error(`Error processing message from ${venue}: ${err}`);
        }
      });
      
      ws.on('error', (err) => {
        this.logger.error(`WebSocket error for ${connectionKey}: ${err.message}`);
      });
      
      ws.on('close', () => {
        connection.isConnected = false;
        this.logger.warn(`Connection to ${connectionKey} closed`);
        this.attemptReconnect(connectionKey);
      });
      
      this.connections.set(connectionKey, connection);
      return true;
    } catch (err) {
      this.logger.error(`Failed to subscribe to ${connectionKey}: ${err}`);
      return false;
    }
  }
  
  private getAdapterForVenue(venue: string): VenueAdapter {
    switch (venue.toUpperCase()) {
      case 'BINANCE':
        return new BinanceAdapter();
      case 'COINBASE':
        return new CoinbaseAdapter();
      case 'KRAKEN':
        return new KrakenAdapter();
      default:
        throw new Error(`Unsupported venue: ${venue}`);
    }
  }
  
  private attemptReconnect(connectionKey: string) {
    const connection = this.connections.get(connectionKey);
    if (!connection) return;
    
    connection.reconnectAttempts += 1;
    
    // Exponential backoff with jitter
    const delay = Math.min(
      1000 * Math.pow(2, connection.reconnectAttempts) + Math.random() * 1000,
      60000 // Max 1 minute
    );
    
    this.logger.info(`Attempting to reconnect to ${connectionKey} in ${delay}ms`);
    
    setTimeout(() => {
      this.subscribeToOrderBook(connection.venue, connection.symbol);
    }, delay);
  }
  
  public unsubscribe(venue: string, symbol: string): boolean {
    const connectionKey = `${venue}:${symbol}`;
    const connection = this.connections.get(connectionKey);
    
    if (!connection) {
      return false;
    }
    
    try {
      if (connection.isConnected) {
        const unsubMessage = connection.adapter.getOrderBookUnsubscriptionMessage(symbol);
        connection.ws.send(JSON.stringify(unsubMessage));
      }
      
      connection.ws.terminate();
      this.connections.delete(connectionKey);
      this.logger.info(`Unsubscribed from ${connectionKey}`);
      return true;
    } catch (err) {
      this.logger.error(`Error unsubscribing from ${connectionKey}: ${err}`);
      return false;
    }
  }
  
  public getActiveSubscriptions(): string[] {
    return Array.from(this.connections.keys());
  }
}