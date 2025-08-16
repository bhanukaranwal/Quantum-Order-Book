import { Logger } from '../utils/Logger';
import { EventEmitter } from '../events/EventEmitter';
import { Redis } from 'ioredis';
import { MarketDataService } from '../services/MarketDataService';
import { ExchangeService } from '../services/ExchangeService';
import { OrderService } from '../services/OrderService';
import { ConfigService } from '../services/ConfigService';
import { MetricsService } from '../services/MetricsService';

/**
 * Arbitrage opportunity
 */
interface ArbitrageOpportunity {
  id: string;
  timestamp: number;
  symbol: string;
  buyVenue: string;
  sellVenue: string;
  buyPrice: number;
  sellPrice: number;
  spread: number;
  spreadPercentage: number;
  maxSize: number;
  fees: number;
  netProfit: number;
  netProfitPercentage: number;
  confidence: number;
  latency: number;
  status: 'detected' | 'executed' | 'missed' | 'invalid';
  execution?: {
    buyOrderId: string;
    sellOrderId: string;
    executedSize: number;
    actualBuyPrice: number;
    actualSellPrice: number;
    actualProfit: number;
    actualProfitPercentage: number;
    executionTime: number;
  };
}

/**
 * Arbitrage execution result
 */
interface ArbitrageExecutionResult {
  success: boolean;
  opportunity: ArbitrageOpportunity;
  error?: string;
}

/**
 * Configuration for the arbitrage engine
 */
interface ArbitrageConfig {
  enabled: boolean;
  minSpreadPercentage: number;
  maxLatencyMs: number;
  maxSlippagePercentage: number;
  minConfidence: number;
  minProfitAmount: number;
  minProfitPercentage: number;
  maxTradeSize: number;
  executionMode: 'manual' | 'automatic' | 'simulated';
  monitoredSymbols: string[];
  excludedVenues: string[];
  updateInterval: number;
  maxConcurrentOpportunities: number;
}

/**
 * Arbitrage Engine for cross-exchange opportunities
 */
export class ArbitrageEngine {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private redis: Redis;
  private marketDataService: MarketDataService;
  private exchangeService: ExchangeService;
  private orderService: OrderService;
  private configService: ConfigService;
  private metricsService: MetricsService;
  
  private config: ArbitrageConfig;
  private isRunning: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;
  private executionQueue: Map<string, ArbitrageOpportunity> = new Map();
  private opportunityHistory: Map<string, ArbitrageOpportunity> = new Map();
  private activeOpportunities: Set<string> = new Set();
  private executingOpportunities: Set<string> = new Set();
  
  constructor(
    logger: Logger,
    eventEmitter: EventEmitter,
    redis: Redis,
    marketDataService: MarketDataService,
    exchangeService: ExchangeService,
    orderService: OrderService,
    configService: ConfigService,
    metricsService: MetricsService,
    config: ArbitrageConfig
  ) {
    this.logger = logger;
    this.eventEmitter = eventEmitter;
    this.redis = redis;
    this.marketDataService = marketDataService;
    this.exchangeService = exchangeService;
    this.orderService = orderService;
    this.configService = configService;
    this.metricsService = metricsService;
    this.config = config;
  }
  
  /**
   * Start the arbitrage engine
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Arbitrage engine is already running');
      return;
    }
    
    // Check if arbitrage is enabled
    if (!this.config.enabled) {
      this.logger.info('Arbitrage engine is disabled in configuration');
      return;
    }
    
    this.isRunning = true;
    this.logger.info('Starting arbitrage engine');
    
    // Load configuration
    await this.loadConfiguration();
    
    // Load active opportunities
    await this.loadActiveOpportunities();
    
    // Start monitoring for opportunities
    this.startOpportunityMonitoring();
    
    // Subscribe to market data events
    this.subscribeToEvents();
    
    this.logger.info('Arbitrage engine started');
  }
  
  /**
   * Stop the arbitrage engine
   */
  public stop(): void {
    if (!this.isRunning) {
      this.logger.warn('Arbitrage engine is not running');
      return;
    }
    
    this.isRunning = false;
    this.logger.info('Stopping arbitrage engine');
    
    // Stop monitoring
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.logger.info('Arbitrage engine stopped');
  }
  
  /**
   * Get detected arbitrage opportunities
   */
  public getOpportunities(
    limit: number = 100, 
    includeHistory: boolean = false
  ): ArbitrageOpportunity[] {
    // Get active opportunities
    const active = Array.from(this.activeOpportunities)
      .map(id => this.opportunityHistory.get(id))
      .filter(Boolean) as ArbitrageOpportunity[];
    
    if (!includeHistory) {
      return active.slice(0, limit);
    }
    
    // Add historical opportunities
    const history = Array.from(this.opportunityHistory.values())
      .filter(opp => !this.activeOpportunities.has(opp.id))
      .sort((a, b) => b.timestamp - a.timestamp);
    
    return [...active, ...history].slice(0, limit);
  }
  
  /**
   * Get a specific opportunity by ID
   */
  public getOpportunity(id: string): ArbitrageOpportunity | undefined {
    return this.opportunityHistory.get(id);
  }
  
  /**
   * Execute an arbitrage opportunity
   */
  public async executeOpportunity(id: string): Promise<ArbitrageExecutionResult> {
    // Get the opportunity
    const opportunity = this.opportunityHistory.get(id);
    
    if (!opportunity) {
      return {
        success: false,
        opportunity: { id } as ArbitrageOpportunity,
        error: 'Opportunity not found'
      };
    }
    
    // Check if opportunity is still active
    if (!this.activeOpportunities.has(id)) {
      return {
        success: false,
        opportunity,
        error: 'Opportunity is no longer active'
      };
    }
    
    // Check if already executing
    if (this.executingOpportunities.has(id)) {
      return {
        success: false,
        opportunity,
        error: 'Opportunity is already being executed'
      };
    }
    
    // Execute the opportunity
    return this.executeArbitrage(opportunity);
  }
  
  /**
   * Add symbol to monitoring list
   */
  public async addSymbol(symbol: string): Promise<boolean> {
    if (this.config.monitoredSymbols.includes(symbol)) {
      return true;
    }
    
    this.config.monitoredSymbols.push(symbol);
    
    // Save configuration
    await this.configService.saveConfig('arbitrage', this.config);
    
    this.logger.info(`Added symbol ${symbol} to arbitrage monitoring`);
    return true;
  }
  
  /**
   * Remove symbol from monitoring list
   */
  public async removeSymbol(symbol: string): Promise<boolean> {
    const index = this.config.monitoredSymbols.indexOf(symbol);
    
    if (index === -1) {
      return false;
    }
    
    this.config.monitoredSymbols.splice(index, 1);
    
    // Save configuration
    await this.configService.saveConfig('arbitrage', this.config);
    
    this.logger.info(`Removed symbol ${symbol} from arbitrage monitoring`);
    return true;
  }
  
  /**
   * Update arbitrage configuration
   */
  public async updateConfiguration(config: Partial<ArbitrageConfig>): Promise<boolean> {
    this.config = {
      ...this.config,
      ...config
    };
    
    // Save configuration
    await this.configService.saveConfig('arbitrage', this.config);
    
    this.logger.info('Updated arbitrage configuration');
    return true;
  }
  
  /**
   * Load configuration from config service
   */
  private async loadConfiguration(): Promise<void> {
    try {
      const config = await this.configService.getConfig<ArbitrageConfig>('arbitrage');
      
      if (config) {
        this.config = {
          ...this.config,
          ...config
        };
        
        this.logger.info('Loaded arbitrage configuration');
      }
    } catch (error) {
      this.logger.error(`Error loading arbitrage configuration: ${error.message}`);
    }
  }
  
  /**
   * Load active opportunities
   */
  private async loadActiveOpportunities(): Promise<void> {
    try {
      // Get active opportunities from Redis
      const activeOpps = await this.redis.smembers('arbitrage:active');
      
      for (const oppId of activeOpps) {
        const oppData = await this.redis.get(`arbitrage:opps:${oppId}`);
        
        if (oppData) {
          const opportunity = JSON.parse(oppData) as ArbitrageOpportunity;
          
          // Store in memory
          this.opportunityHistory.set(oppId, opportunity);
          this.activeOpportunities.add(oppId);
        }
      }
      
      this.logger.info(`Loaded ${this.activeOpportunities.size} active arbitrage opportunities`);
    } catch (error) {
      this.logger.error(`Error loading active opportunities: ${error.message}`);
    }
  }
  
  /**
   * Start monitoring for arbitrage opportunities
   */
  private startOpportunityMonitoring(): void {
    this.updateInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.scanForOpportunities();
      } catch (error) {
        this.logger.error(`Error scanning for opportunities: ${error.message}`);
      }
    }, this.config.updateInterval);
    
    // Perform initial scan
    setTimeout(async () => {
      if (this.isRunning) {
        try {
          await this.scanForOpportunities();
        } catch (error) {
          this.logger.error(`Error in initial opportunity scan: ${error.message}`);
        }
      }
    }, 1000);
  }
  
  /**
   * Scan for arbitrage opportunities
   */
  private async scanForOpportunities(): Promise<void> {
    // Get all venues
    const allVenues = await this.exchangeService.getAvailableVenues();
    
    // Filter out excluded venues
    const venues = allVenues.filter(venue => !this.config.excludedVenues.includes(venue));
    
    // Skip if less than 2 venues
    if (venues.length < 2) {
      this.logger.debug('Not enough venues for arbitrage');
      return;
    }
    
    // Scan each monitored symbol
    for (const symbol of this.config.monitoredSymbols) {
      await this.scanSymbolForOpportunities(symbol, venues);
    }
  }
  
  /**
   * Scan a specific symbol for arbitrage opportunities
   */
  private async scanSymbolForOpportunities(symbol: string, venues: string[]): Promise<void> {
    try {
      const startTime = Date.now();
      
      // Get order books for all venues
      const orderBooks: Record<string, any> = {};
      
      for (const venue of venues) {
        try {
          const orderBook = await this.marketDataService.getOrderBook(venue, symbol);
          
          if (orderBook && orderBook.bids && orderBook.asks && 
              orderBook.bids.length > 0 && orderBook.asks.length > 0) {
            orderBooks[venue] = orderBook;
          }
        } catch (error) {
          this.logger.debug(`Error getting order book for ${venue}/${symbol}: ${error.message}`);
        }
      }
      
      // Check if we have at least 2 venues with order books
      const venuesWithOrderBooks = Object.keys(orderBooks);
      
      if (venuesWithOrderBooks.length < 2) {
        return;
      }
      
      // Find arbitrage opportunities
      const opportunities: ArbitrageOpportunity[] = [];
      
      for (let i = 0; i < venuesWithOrderBooks.length; i++) {
        for (let j = i + 1; j < venuesWithOrderBooks.length; j++) {
          const venue1 = venuesWithOrderBooks[i];
          const venue2 = venuesWithOrderBooks[j];
          
          // Check venue1 buy, venue2 sell
          const opp1 = this.checkArbitrageOpportunity(
            symbol,
            venue1,
            venue2,
            orderBooks[venue1],
            orderBooks[venue2]
          );
          
          if (opp1) opportunities.push(opp1);
          
          // Check venue2 buy, venue1 sell
          const opp2 = this.checkArbitrageOpportunity(
            symbol,
            venue2,
            venue1,
            orderBooks[venue2],
            orderBooks[venue1]
          );
          
          if (opp2) opportunities.push(opp2);
        }
      }
      
      // Process detected opportunities
      for (const opportunity of opportunities) {
        await this.processOpportunity(opportunity);
      }
      
      // Calculate latency
      const latency = Date.now() - startTime;
      
      // Record metrics
      this.metricsService.recordArbitrageScan(symbol, venues.length, opportunities.length, latency);
      
      if (opportunities.length > 0) {
        this.logger.debug(`Found ${opportunities.length} arbitrage opportunities for ${symbol}`);
      }
    } catch (error) {
      this.logger.error(`Error scanning ${symbol} for arbitrage: ${error.message}`);
    }
  }
  
  /**
   * Check for arbitrage opportunity between two venues
   */
  private checkArbitrageOpportunity(
    symbol: string,
    buyVenue: string,
    sellVenue: string,
    buyOrderBook: any,
    sellOrderBook: any
  ): ArbitrageOpportunity | null {
    try {
      // Get best buy price (highest bid on sell venue)
      const bestBuyPrice = sellOrderBook.bids[0][0];
      
      // Get best sell price (lowest ask on buy venue)
      const bestSellPrice = buyOrderBook.asks[0][0];
      
      // Check if there's a spread
      if (bestBuyPrice <= bestSellPrice) {
        return null; // No arbitrage opportunity
      }
      
      // Calculate spread
      const spread = bestBuyPrice - bestSellPrice;
      const spreadPercentage = spread / bestSellPrice * 100;
      
      // Check if spread meets minimum threshold
      if (spreadPercentage < this.config.minSpreadPercentage) {
        return null;
      }
      
      // Calculate maximum size based on available liquidity
      const maxBuySize = buyOrderBook.asks[0][1];
      const maxSellSize = sellOrderBook.bids[0][1];
      const maxSize = Math.min(maxBuySize, maxSellSize, this.config.maxTradeSize);
      
      // Calculate fees
      const buyFee = this.calculateFee(buyVenue, maxSize * bestSellPrice);
      const sellFee = this.calculateFee(sellVenue, maxSize * bestBuyPrice);
      const totalFees = buyFee + sellFee;
      
      // Calculate net profit
      const grossProfit = (bestBuyPrice - bestSellPrice) * maxSize;
      const netProfit = grossProfit - totalFees;
      const netProfitPercentage = netProfit / (maxSize * bestSellPrice) * 100;
      
      // Check if profit meets minimum threshold
      if (netProfit < this.config.minProfitAmount || 
          netProfitPercentage < this.config.minProfitPercentage) {
        return null;
      }
      
      // Calculate confidence based on depth
      const confidence = this.calculateConfidence(
        buyOrderBook,
        sellOrderBook,
        maxSize,
        bestSellPrice,
        bestBuyPrice
      );
      
      // Check confidence threshold
      if (confidence < this.config.minConfidence) {
        return null;
      }
      
      // Create opportunity object
      const opportunity: ArbitrageOpportunity = {
        id: `arb_${buyVenue}_${sellVenue}_${symbol}_${Date.now()}`,
        timestamp: Date.now(),
        symbol,
        buyVenue,
        sellVenue,
        buyPrice: bestSellPrice,
        sellPrice: bestBuyPrice,
        spread,
        spreadPercentage,
        maxSize,
        fees: totalFees,
        netProfit,
        netProfitPercentage,
        confidence,
        latency: 0, // Will be updated later
        status: 'detected'
      };
      
      return opportunity;
    } catch (error) {
      this.logger.error(`Error checking arbitrage opportunity: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Process a detected arbitrage opportunity
   */
  private async processOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    // Calculate latency
    opportunity.latency = Date.now() - opportunity.timestamp;
    
    // Check if latency is too high
    if (opportunity.latency > this.config.maxLatencyMs) {
      opportunity.status = 'missed';
      this.opportunityHistory.set(opportunity.id, opportunity);
      
      this.logger.debug(`Missed arbitrage opportunity due to high latency: ${opportunity.latency}ms`);
      return;
    }
    
    // Store opportunity
    this.opportunityHistory.set(opportunity.id, opportunity);
    this.activeOpportunities.add(opportunity.id);
    
    // Save to Redis
    await this.redis.set(
      `arbitrage:opps:${opportunity.id}`, 
      JSON.stringify(opportunity),
      'EX',
      60 * 60 // Expire after 1 hour
    );
    await this.redis.sadd('arbitrage:active', opportunity.id);
    
    // Emit event
    this.eventEmitter.emit('arbitrage:opportunity_detected', { opportunity });
    
    // Execute automatically if configured
    if (this.config.executionMode === 'automatic') {
      this.executionQueue.set(opportunity.id, opportunity);
      
      // Execute asynchronously
      setTimeout(async () => {
        if (this.executionQueue.has(opportunity.id)) {
          this.executionQueue.delete(opportunity.id);
          await this.executeArbitrage(opportunity);
        }
      }, 0);
    } else if (this.config.executionMode === 'simulated') {
      // Simulate execution for testing
      await this.simulateArbitrageExecution(opportunity);
    }
  }
  
  /**
   * Execute an arbitrage opportunity
   */
  private async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    if (!this.isRunning) {
      return {
        success: false,
        opportunity,
        error: 'Arbitrage engine is not running'
      };
    }
    
    // Check if opportunity is still active
    if (!this.activeOpportunities.has(opportunity.id)) {
      return {
        success: false,
        opportunity,
        error: 'Opportunity is no longer active'
      };
    }
    
    // Check if already executing
    if (this.executingOpportunities.has(opportunity.id)) {
      return {
        success: false,
        opportunity,
        error: 'Opportunity is already being executed'
      };
    }
    
    // Mark as executing
    this.executingOpportunities.add(opportunity.id);
    
    try {
      this.logger.info(`Executing arbitrage opportunity ${opportunity.id}`);
      
      const executionStart = Date.now();
      
      // Place buy order
      const buyOrder = await this.orderService.placeOrder({
        venue: opportunity.buyVenue,
        symbol: opportunity.symbol,
        side: 'buy',
        type: 'limit',
        price: opportunity.buyPrice,
        quantity: opportunity.maxSize,
        clientOrderId: `arb_buy_${opportunity.id}`
      });
      
      // Place sell order
      const sellOrder = await this.orderService.placeOrder({
        venue: opportunity.sellVenue,
        symbol: opportunity.symbol,
        side: 'sell',
        type: 'limit',
        price: opportunity.sellPrice,
        quantity: opportunity.maxSize,
        clientOrderId: `arb_sell_${opportunity.id}`
      });
      
      // Wait for orders to be filled or timeout
      const buyResult = await this.waitForOrderExecution(buyOrder.id, 5000);
      const sellResult = await this.waitForOrderExecution(sellOrder.id, 5000);
      
      // Calculate actual execution metrics
      const executedSize = Math.min(
        buyResult.executedQuantity || 0, 
        sellResult.executedQuantity || 0
      );
      
      const actualBuyPrice = buyResult.averagePrice || opportunity.buyPrice;
      const actualSellPrice = sellResult.averagePrice || opportunity.sellPrice;
      
      const actualProfit = (actualSellPrice - actualBuyPrice) * executedSize;
      const actualProfitPercentage = actualProfit / (executedSize * actualBuyPrice) * 100;
      
      // Update opportunity with execution details
      opportunity.status = 'executed';
      opportunity.execution = {
        buyOrderId: buyOrder.id,
        sellOrderId: sellOrder.id,
        executedSize,
        actualBuyPrice,
        actualSellPrice,
        actualProfit,
        actualProfitPercentage,
        executionTime: Date.now() - executionStart
      };
      
      // Update in memory and Redis
      this.opportunityHistory.set(opportunity.id, opportunity);
      await this.redis.set(
        `arbitrage:opps:${opportunity.id}`, 
        JSON.stringify(opportunity),
        'EX',
        60 * 60 * 24 // Expire after 24 hours
      );
      
      // Remove from active opportunities
      this.activeOpportunities.delete(opportunity.id);
      await this.redis.srem('arbitrage:active', opportunity.id);
      
      // Emit event
      this.eventEmitter.emit('arbitrage:opportunity_executed', { opportunity });
      
      this.logger.info(`Successfully executed arbitrage opportunity ${opportunity.id}`);
      
      return {
        success: true,
        opportunity
      };
    } catch (error) {
      this.logger.error(`Error executing arbitrage opportunity: ${error.message}`);
      
      // Update opportunity status
      opportunity.status = 'invalid';
      this.opportunityHistory.set(opportunity.id, opportunity);
      
      // Remove from active opportunities
      this.activeOpportunities.delete(opportunity.id);
      await this.redis.srem('arbitrage:active', opportunity.id);
      
      return {
        success: false,
        opportunity,
        error: error.message
      };
    } finally {
      // No longer executing
      this.executingOpportunities.delete(opportunity.id);
    }
  }
  
  /**
   * Simulate arbitrage execution for testing
   */
  private async simulateArbitrageExecution(opportunity: ArbitrageOpportunity): Promise<void> {
    // Add random delay for realism
    const delay = Math.floor(Math.random() * 500) + 100;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Apply random slippage
    const slippagePercent = Math.random() * 0.2;
    const actualBuyPrice = opportunity.buyPrice * (1 + slippagePercent);
    const actualSellPrice = opportunity.sellPrice * (1 - slippagePercent);
    
    // Random executed size (80-100% of max)
    const executedSize = opportunity.maxSize * (0.8 + Math.random() * 0.2);
    
    // Calculate actual profit
    const actualProfit = (actualSellPrice - actualBuyPrice) * executedSize;
    const actualProfitPercentage = actualProfit / (executedSize * actualBuyPrice) * 100;
    
    // Update opportunity with simulated execution
    opportunity.status = 'executed';
    opportunity.execution = {
      buyOrderId: `sim_buy_${opportunity.id}`,
      sellOrderId: `sim_sell_${opportunity.id}`,
      executedSize,
      actualBuyPrice,
      actualSellPrice,
      actualProfit,
      actualProfitPercentage,
      executionTime: delay
    };
    
    // Update in memory
    this.opportunityHistory.set(opportunity.id, opportunity);
    
    // Remove from active opportunities
    this.activeOpportunities.delete(opportunity.id);
    await this.redis.srem('arbitrage:active', opportunity.id);
    
    // Emit event
    this.eventEmitter.emit('arbitrage:opportunity_simulated', { opportunity });
    
    this.logger.debug(`Simulated arbitrage execution for ${opportunity.id}`);
  }
  
  /**
   * Wait for an order to be executed
   */
  private async waitForOrderExecution(
    orderId: string, 
    timeoutMs: number
  ): Promise<{ executedQuantity?: number; averagePrice?: number }> {
    return new Promise(resolve => {
      const startTime = Date.now();
      
      const checkOrder = async () => {
        // Get order status
        const order = await this.orderService.getOrder(orderId);
        
        if (order && (order.status === 'filled' || order.status === 'partially_filled')) {
          resolve({
            executedQuantity: order.executedQuantity,
            averagePrice: order.averagePrice
          });
          return;
        }
        
        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          resolve({});
          return;
        }
        
        // Check again after delay
        setTimeout(checkOrder, 200);
      };
      
      checkOrder();
    });
  }
  
  /**
   * Calculate fee for an order
   */
  private calculateFee(venue: string, value: number): number {
    // Get fee structure for this venue
    const feeStructure = this.exchangeService.getVenueFeeStructure(venue);
    
    if (!feeStructure) return value * 0.001; // Default to 0.1%
    
    return value * (feeStructure.takerFeeBps / 10000);
  }
  
  /**
   * Calculate confidence score for an arbitrage opportunity
   */
  private calculateConfidence(
    buyOrderBook: any,
    sellOrderBook: any,
    size: number,
    buyPrice: number,
    sellPrice: number
  ): number {
    try {
      // Check market depth
      let buyLiquidity = 0;
      let sellLiquidity = 0;
      
      // Sum up buy liquidity
      for (const [price, quantity] of buyOrderBook.asks) {
        if (price <= buyPrice * 1.01) { // Within 1% of best price
          buyLiquidity += quantity;
        }
      }
      
      // Sum up sell liquidity
      for (const [price, quantity] of sellOrderBook.bids) {
        if (price >= sellPrice * 0.99) { // Within 1% of best price
          sellLiquidity += quantity;
        }
      }
      
      // Calculate depth ratio
      const depthRatio = Math.min(buyLiquidity, sellLiquidity) / size;
      
      // Calculate price stability
      const buyPriceStability = this.calculatePriceStability(buyOrderBook.asks);
      const sellPriceStability = this.calculatePriceStability(sellOrderBook.bids);
      
      // Combined confidence score
      const confidence = (
        (depthRatio * 0.5) + 
        (buyPriceStability * 0.25) + 
        (sellPriceStability * 0.25)
      );
      
      return Math.min(confidence, 1);
    } catch (error) {
      this.logger.error(`Error calculating confidence: ${error.message}`);
      return 0;
    }
  }
  
  /**
   * Calculate price stability from order book
   */
  private calculatePriceStability(levels: number[][]): number {
    if (levels.length < 2) return 0;
    
    // Calculate average price gap
    let totalGap = 0;
    
    for (let i = 1; i < Math.min(5, levels.length); i++) {
      const gap = Math.abs(levels[i][0] - levels[i-1][0]) / levels[0][0];
      totalGap += gap;
    }
    
    const avgGap = totalGap / Math.min(4, levels.length - 1);
    
    // Lower gap means higher stability
    return 1 - Math.min(avgGap * 10, 1);
  }
  
  /**
   * Subscribe to market data events
   */
  private subscribeToEvents(): void {
    // Subscribe to order book updates
    this.eventEmitter.on('orderbook:updated', async (data: any) => {
      try {
        const { venue, symbol } = data;
        
        // Check if this symbol is monitored
        if (this.config.monitoredSymbols.includes(symbol) && this.isRunning) {
          // Get other venues that have this symbol
          const allVenues = await this.exchangeService.getVenuesForSymbol(symbol);
          const otherVenues = allVenues.filter(v => v !== venue && !this.config.excludedVenues.includes(v));
          
          // Check for opportunities with each other venue
          for (const otherVenue of otherVenues) {
            this.checkCrossExchangeOpportunity(symbol, venue, otherVenue);
          }
        }
      } catch (error) {
        this.logger.error(`Error handling orderbook update event: ${error.message}`);
      }
    });
    
    // Subscribe to config updates
    this.eventEmitter.on('config:updated', async (data: any) => {
      try {
        if (data.component === 'arbitrage') {
          this.config = {
            ...this.config,
            ...data.config
          };
          this.logger.info('Updated arbitrage configuration');
        }
      } catch (error) {
        this.logger.error(`Error handling config update: ${error.message}`);
      }
    });
  }
  
  /**
   * Check for arbitrage opportunities between two specific venues
   */
  private async checkCrossExchangeOpportunity(
    symbol: string,
    venue1: string,
    venue2: string
  ): Promise<void> {
    try {
      // Get order books
      const orderBook1 = await this.marketDataService.getOrderBook(venue1, symbol);
      const orderBook2 = await this.marketDataService.getOrderBook(venue2, symbol);
      
      if (!orderBook1 || !orderBook2 || 
          !orderBook1.bids || !orderBook1.asks || 
          !orderBook2.bids || !orderBook2.asks || 
          orderBook1.bids.length === 0 || orderBook1.asks.length === 0 || 
          orderBook2.bids.length === 0 || orderBook2.asks.length === 0) {
        return;
      }
      
      // Check both directions
      const opp1 = this.checkArbitrageOpportunity(symbol, venue1, venue2, orderBook1, orderBook2);
      if (opp1) await this.processOpportunity(opp1);
      
      const opp2 = this.checkArbitrageOpportunity(symbol, venue2, venue1, orderBook2, orderBook1);
      if (opp2) await this.processOpportunity(opp2);
    } catch (error) {
      this.logger.error(`Error checking cross-exchange opportunity: ${error.message}`);
    }
  }
}