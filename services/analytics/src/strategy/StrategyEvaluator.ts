import { Logger } from '../utils/Logger';
import { OrderBookService } from '../services/OrderBookService';
import { TradeHistoryService } from '../services/TradeHistoryService';
import { MarketIndicatorsService } from '../services/MarketIndicatorsService';
import { AIModelService } from '../ai/AIModelService';
import { Redis } from 'ioredis';
import { EventEmitter } from '../events/EventEmitter';

interface Strategy {
  id: string;
  name: string;
  description: string;
  creator: string;
  parameters: Record<string, any>;
  entryConditions: StrategyCondition[];
  exitConditions: StrategyCondition[];
  riskManagement: {
    maxPositionSize: number;
    maxDrawdown: number;
    stopLossPercentage: number;
    takeProfitPercentage: number;
    trailingStopPercentage?: number;
  };
  timeframes: string[];
  markets: {
    venue: string;
    symbol: string;
  }[];
  status: 'active' | 'inactive' | 'backtest' | 'paper-trading';
  performance?: StrategyPerformance;
}

interface StrategyCondition {
  type: 'indicator' | 'price' | 'volume' | 'orderbook' | 'sentiment' | 'custom';
  indicator?: string;
  operator: 'greater' | 'less' | 'equal' | 'cross_above' | 'cross_below';
  value: number | string;
  timeframe?: string;
  lookback?: number;
  parameters?: Record<string, any>;
}

interface StrategyPerformance {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  averageProfit: number;
  averageLoss: number;
  averageHoldingTime: number;
  totalReturn: number;
  annualizedReturn: number;
}

interface StrategyEvaluation {
  id: string;
  strategyId: string;
  timestamp: number;
  entryScores: {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  }[];
  exitScores: {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  }[];
  overallEntryScore: number;
  overallExitScore: number;
  recommendation: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  market: {
    venue: string;
    symbol: string;
    price: number;
    timestamp: number;
  };
  suggestedParameters?: {
    entryPrice?: number;
    exitPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    positionSize?: number;
  };
  aiEnhancements?: {
    forecastedPrice: number;
    forecastConfidence: number;
    marketRegime: string;
    anomalyScore: number;
    sentimentScore: number;
  };
}

export class StrategyEvaluator {
  private logger: Logger;
  private orderBookService: OrderBookService;
  private tradeHistoryService: TradeHistoryService;
  private marketIndicatorsService: MarketIndicatorsService;
  private aiModelService: AIModelService;
  private redis: Redis;
  private eventEmitter: EventEmitter;
  private strategies: Map<string, Strategy> = new Map();
  private evaluations: Map<string, StrategyEvaluation[]> = new Map();
  private evaluationInterval: number = 60000; // 1 minute
  private evaluationTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  constructor(
    orderBookService: OrderBookService,
    tradeHistoryService: TradeHistoryService,
    marketIndicatorsService: MarketIndicatorsService,
    aiModelService: AIModelService,
    redis: Redis,
    eventEmitter: EventEmitter
  ) {
    this.logger = new Logger('StrategyEvaluator');
    this.orderBookService = orderBookService;
    this.tradeHistoryService = tradeHistoryService;
    this.marketIndicatorsService = marketIndicatorsService;
    this.aiModelService = aiModelService;
    this.redis = redis;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Start the strategy evaluator service
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Strategy evaluator is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting strategy evaluator service');

    // Load strategies from database
    await this.loadStrategies();

    // Start evaluation timers for active strategies
    this.startEvaluationTimers();

    // Subscribe to strategy-related events
    this.subscribeToEvents();

    this.logger.info(`Started evaluation for ${this.evaluationTimers.size} active strategies`);
  }

  /**
   * Stop the strategy evaluator service
   */
  public stop(): void {
    if (!this.isRunning) {
      this.logger.warn('Strategy evaluator is not running');
      return;
    }

    this.isRunning = false;
    this.logger.info('Stopping strategy evaluator service');

    // Clear all evaluation timers
    for (const [strategyId, timer] of this.evaluationTimers.entries()) {
      clearTimeout(timer);
      this.logger.debug(`Stopped evaluation timer for strategy ${strategyId}`);
    }

    this.evaluationTimers.clear();
    this.logger.info('Strategy evaluator service stopped');
  }

  /**
   * Register a new strategy for evaluation
   */
  public async registerStrategy(strategy: Strategy): Promise<void> {
    try {
      // Validate strategy
      this.validateStrategy(strategy);

      // Store strategy
      this.strategies.set(strategy.id, strategy);
      
      // If strategy is active, start evaluation
      if (strategy.status === 'active') {
        this.startStrategyEvaluation(strategy.id);
      }

      // Save to database (in a real implementation)
      await this.saveStrategyToDatabase(strategy);

      this.logger.info(`Registered strategy ${strategy.id}: ${strategy.name}`);
    } catch (error) {
      this.logger.error(`Failed to register strategy: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update an existing strategy
   */
  public async updateStrategy(strategyId: string, updates: Partial<Strategy>): Promise<void> {
    try {
      const strategy = this.strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Apply updates
      const updatedStrategy = { ...strategy, ...updates };
      
      // Validate updated strategy
      this.validateStrategy(updatedStrategy);

      // Update strategy in memory
      this.strategies.set(strategyId, updatedStrategy);

      // Handle status changes
      if (strategy.status !== updatedStrategy.status) {
        if (updatedStrategy.status === 'active') {
          this.startStrategyEvaluation(strategyId);
        } else {
          this.stopStrategyEvaluation(strategyId);
        }
      }

      // Save to database (in a real implementation)
      await this.saveStrategyToDatabase(updatedStrategy);

      this.logger.info(`Updated strategy ${strategyId}`);
    } catch (error) {
      this.logger.error(`Failed to update strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a strategy
   */
  public async deleteStrategy(strategyId: string): Promise<void> {
    try {
      const strategy = this.strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Stop evaluation if running
      this.stopStrategyEvaluation(strategyId);

      // Remove from memory
      this.strategies.delete(strategyId);
      this.evaluations.delete(strategyId);

      // Remove from database (in a real implementation)
      await this.deleteStrategyFromDatabase(strategyId);

      this.logger.info(`Deleted strategy ${strategyId}`);
    } catch (error) {
      this.logger.error(`Failed to delete strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a strategy by ID
   */
  public getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  /**
   * Get all strategies
   */
  public getStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get recent evaluations for a strategy
   */
  public getStrategyEvaluations(
    strategyId: string, 
    limit: number = 10
  ): StrategyEvaluation[] {
    const evaluations = this.evaluations.get(strategyId) || [];
    return evaluations.slice(0, limit);
  }

  /**
   * Evaluate a strategy immediately for the specified market
   */
  public async evaluateStrategyNow(
    strategyId: string, 
    venue: string, 
    symbol: string
  ): Promise<StrategyEvaluation> {
    try {
      const strategy = this.strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Check if this market is supported by the strategy
      const isMarketSupported = strategy.markets.some(
        m => m.venue === venue && m.symbol === symbol
      );

      if (!isMarketSupported) {
        throw new Error(`Market ${venue}:${symbol} is not supported by strategy ${strategyId}`);
      }

      const evaluation = await this.evaluateStrategy(strategy, venue, symbol);
      this.logger.info(`Manual evaluation of strategy ${strategyId} for ${venue}:${symbol} completed`);

      return evaluation;
    } catch (error) {
      this.logger.error(`Failed to evaluate strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Optimize a strategy using AI
   */
  public async optimizeStrategy(strategyId: string): Promise<Strategy> {
    try {
      const strategy = this.strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      this.logger.info(`Starting optimization for strategy ${strategyId}`);

      // Use AI model to optimize strategy parameters
      const optimizedParameters = await this.aiModelService.optimizeStrategyParameters(
        strategy,
        strategy.markets,
        strategy.timeframes
      );

      // Create optimized strategy
      const optimizedStrategy: Strategy = {
        ...strategy,
        id: `${strategy.id}_optimized`,
        name: `${strategy.name} (Optimized)`,
        parameters: optimizedParameters.parameters,
        entryConditions: optimizedParameters.entryConditions || strategy.entryConditions,
        exitConditions: optimizedParameters.exitConditions || strategy.exitConditions,
        riskManagement: optimizedParameters.riskManagement || strategy.riskManagement,
        status: 'inactive' // Start as inactive for safety
      };

      // Register the optimized strategy
      await this.registerStrategy(optimizedStrategy);

      this.logger.info(`Created optimized strategy ${optimizedStrategy.id} from ${strategyId}`);

      return optimizedStrategy;
    } catch (error) {
      this.logger.error(`Failed to optimize strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Perform backtesting on a strategy
   */
  public async backtestStrategy(
    strategyId: string, 
    startDate: Date, 
    endDate: Date
  ): Promise<StrategyPerformance> {
    try {
      const strategy = this.strategies.get(strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      this.logger.info(`Starting backtest for strategy ${strategyId} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

      // Delegate to AI model service for backtesting
      const performance = await this.aiModelService.backtestStrategy(
        strategy,
        startDate,
        endDate
      );

      // Save performance results
      const updatedStrategy = { ...strategy, performance };
      this.strategies.set(strategyId, updatedStrategy);

      // Save to database (in a real implementation)
      await this.saveStrategyToDatabase(updatedStrategy);

      this.logger.info(`Completed backtest for strategy ${strategyId}, win rate: ${performance.winRate.toFixed(2)}%, total return: ${performance.totalReturn.toFixed(2)}%`);

      return performance;
    } catch (error) {
      this.logger.error(`Failed to backtest strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start all evaluation timers for active strategies
   */
  private startEvaluationTimers(): void {
    for (const [id, strategy] of this.strategies.entries()) {
      if (strategy.status === 'active') {
        this.startStrategyEvaluation(id);
      }
    }
  }

  /**
   * Start evaluation timer for a specific strategy
   */
  private startStrategyEvaluation(strategyId: string): void {
    if (this.evaluationTimers.has(strategyId)) {
      this.logger.debug(`Evaluation timer already running for strategy ${strategyId}`);
      return;
    }

    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      this.logger.error(`Cannot start evaluation for unknown strategy ${strategyId}`);
      return;
    }

    const evaluationFunc = async () => {
      try {
        for (const market of strategy.markets) {
          await this.evaluateStrategy(strategy, market.venue, market.symbol);
        }

        // Schedule next evaluation if still active
        if (this.isRunning && strategy.status === 'active') {
          const timer = setTimeout(evaluationFunc, this.evaluationInterval);
          this.evaluationTimers.set(strategyId, timer);
        }
      } catch (error) {
        this.logger.error(`Error during strategy evaluation for ${strategyId}: ${error.message}`);
        
        // Retry after a delay
        if (this.isRunning && strategy.status === 'active') {
          const timer = setTimeout(evaluationFunc, this.evaluationInterval);
          this.evaluationTimers.set(strategyId, timer);
        }
      }
    };

    // Start initial evaluation
    const timer = setTimeout(evaluationFunc, 0);
    this.evaluationTimers.set(strategyId, timer);
    this.logger.debug(`Started evaluation timer for strategy ${strategyId}`);
  }

  /**
   * Stop evaluation timer for a specific strategy
   */
  private stopStrategyEvaluation(strategyId: string): void {
    const timer = this.evaluationTimers.get(strategyId);
    if (timer) {
      clearTimeout(timer);
      this.evaluationTimers.delete(strategyId);
      this.logger.debug(`Stopped evaluation timer for strategy ${strategyId}`);
    }
  }

  /**
   * Evaluate a strategy for a specific market
   */
  private async evaluateStrategy(
    strategy: Strategy, 
    venue: string, 
    symbol: string
  ): Promise<StrategyEvaluation> {
    const startTime = Date.now();
    this.logger.debug(`Evaluating strategy ${strategy.id} for ${venue}:${symbol}`);

    try {
      // Get current market data
      const orderBook = await this.orderBookService.getOrderBook(venue, symbol);
      const recentTrades = await this.tradeHistoryService.getRecentTrades(venue, symbol, 100);
      
      if (!orderBook || !recentTrades || recentTrades.length === 0) {
        throw new Error(`Insufficient market data for ${venue}:${symbol}`);
      }

      const currentPrice = recentTrades[0].price;
      const marketTimestamp = recentTrades[0].timestamp;

      // Prepare indicator data
      const indicatorData = await this.prepareIndicatorData(strategy, venue, symbol);

      // Get AI model predictions
      const aiPrediction = await this.aiModelService.getPricePrediction(venue, symbol);
      const sentimentAnalysis = await this.aiModelService.getMarketSentiment(venue, symbol);
      const anomalyDetection = await this.aiModelService.detectAnomalies(venue, symbol);
      const marketRegime = await this.aiModelService.identifyMarketRegime(venue, symbol);

      // Evaluate entry conditions
      const entryScores = await Promise.all(
        strategy.entryConditions.map(condition => 
          this.evaluateCondition(condition, indicatorData, orderBook, recentTrades)
        )
      );

      // Evaluate exit conditions
      const exitScores = await Promise.all(
        strategy.exitConditions.map(condition => 
          this.evaluateCondition(condition, indicatorData, orderBook, recentTrades)
        )
      );

      // Calculate overall scores
      const overallEntryScore = this.calculateOverallScore(entryScores);
      const overallExitScore = this.calculateOverallScore(exitScores);

      // Determine recommendation
      const recommendation = this.determineRecommendation(
        overallEntryScore,
        overallExitScore,
        aiPrediction,
        sentimentAnalysis,
        anomalyDetection
      );

      // Calculate suggested parameters
      const suggestedParameters = this.calculateSuggestedParameters(
        strategy,
        currentPrice,
        recommendation,
        aiPrediction
      );

      // Create evaluation object
      const evaluation: StrategyEvaluation = {
        id: `eval_${strategy.id}_${Date.now()}`,
        strategyId: strategy.id,
        timestamp: Date.now(),
        entryScores,
        exitScores,
        overallEntryScore,
        overallExitScore,
        recommendation,
        market: {
          venue,
          symbol,
          price: currentPrice,
          timestamp: marketTimestamp
        },
        suggestedParameters,
        aiEnhancements: {
          forecastedPrice: aiPrediction.predictedPrice,
          forecastConfidence: aiPrediction.confidence,
          marketRegime: marketRegime.regime,
          anomalyScore: anomalyDetection.anomalyScore,
          sentimentScore: sentimentAnalysis.sentiment
        }
      };

      // Store evaluation
      this.storeEvaluation(strategy.id, evaluation);

      // Emit evaluation event
      this.eventEmitter.emit('strategy:evaluation', {
        strategyId: strategy.id,
        evaluation
      });

      const duration = Date.now() - startTime;
      this.logger.debug(`Evaluation of strategy ${strategy.id} for ${venue}:${symbol} completed in ${duration}ms`);

      return evaluation;
    } catch (error) {
      this.logger.error(`Error evaluating strategy ${strategy.id} for ${venue}:${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Evaluate a single strategy condition
   */
  private async evaluateCondition(
    condition: StrategyCondition,
    indicatorData: any,
    orderBook: any,
    recentTrades: any[]
  ): Promise<{
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  }> {
    try {
      let satisfied = false;
      let confidence = 0;
      let details: any = {};

      switch (condition.type) {
        case 'indicator':
          return this.evaluateIndicatorCondition(condition, indicatorData);
        
        case 'price':
          return this.evaluatePriceCondition(condition, recentTrades);
        
        case 'volume':
          return this.evaluateVolumeCondition(condition, recentTrades);
        
        case 'orderbook':
          return this.evaluateOrderBookCondition(condition, orderBook);
        
        case 'sentiment':
          return this.evaluateSentimentCondition(condition);
        
        case 'custom':
          // Custom conditions would typically call out to a plugin or custom script
          // For this example, we'll just return a placeholder
          return {
            condition,
            satisfied: Math.random() > 0.5,
            confidence: 0.7,
            details: { message: 'Custom condition evaluation (placeholder)' }
          };
        
        default:
          throw new Error(`Unknown condition type: ${condition.type}`);
      }
    } catch (error) {
      this.logger.error(`Error evaluating condition: ${error.message}`);
      return {
        condition,
        satisfied: false,
        confidence: 0,
        details: { error: error.message }
      };
    }
  }

  /**
   * Evaluate an indicator-based condition
   */
  private async evaluateIndicatorCondition(
    condition: StrategyCondition,
    indicatorData: any
  ): Promise<{
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  }> {
    if (!condition.indicator) {
      throw new Error('Indicator name is required for indicator condition');
    }

    const indicator = indicatorData[condition.indicator];
    if (!indicator) {
      throw new Error(`Indicator data not found: ${condition.indicator}`);
    }

    const currentValue = indicator.values[0];
    const previousValue = indicator.values[1];
    let satisfied = false;
    let confidence = 0.8; // Base confidence

    // Evaluate based on operator
    switch (condition.operator) {
      case 'greater':
        satisfied = currentValue > parseFloat(condition.value.toString());
        confidence = this.calculateConfidenceForThreshold(
          currentValue, 
          parseFloat(condition.value.toString()),
          'greater'
        );
        break;
      
      case 'less':
        satisfied = currentValue < parseFloat(condition.value.toString());
        confidence = this.calculateConfidenceForThreshold(
          currentValue, 
          parseFloat(condition.value.toString()),
          'less'
        );
        break;
      
      case 'equal':
        // For floating point, we use an epsilon for approximate equality
        satisfied = Math.abs(currentValue - parseFloat(condition.value.toString())) < 0.0001;
        confidence = satisfied ? 1.0 : 0.0; // Binary confidence for equality
        break;
      
      case 'cross_above':
        satisfied = previousValue <= parseFloat(condition.value.toString()) && 
                   currentValue > parseFloat(condition.value.toString());
        confidence = satisfied ? 0.9 : 0.0; // High confidence for confirmed crossover
        break;
      
      case 'cross_below':
        satisfied = previousValue >= parseFloat(condition.value.toString()) && 
                   currentValue < parseFloat(condition.value.toString());
        confidence = satisfied ? 0.9 : 0.0; // High confidence for confirmed crossover
        break;
      
      default:
        throw new Error(`Unknown operator: ${condition.operator}`);
    }

    return {
      condition,
      satisfied,
      confidence,
      details: {
        currentValue,
        previousValue,
        threshold: parseFloat(condition.value.toString())
      }
    };
  }

  /**
   * Evaluate a price-based condition
   */
  private evaluatePriceCondition(
    condition: StrategyCondition,
    recentTrades: any[]
  ): {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  } {
    if (recentTrades.length < 2) {
      throw new Error('Insufficient trade data for price condition evaluation');
    }

    const currentPrice = recentTrades[0].price;
    const previousPrice = recentTrades[1].price;
    let satisfied = false;
    let confidence = 0.8; // Base confidence

    // Convert condition value to number or handle dynamic values
    let threshold: number;
    if (typeof condition.value === 'string' && condition.value.startsWith('$')) {
      // Dynamic reference like "$SMA(20)" would be resolved here
      // For this example, we'll just use a random value
      threshold = currentPrice * (0.9 + Math.random() * 0.2);
    } else {
      threshold = parseFloat(condition.value.toString());
    }

    switch (condition.operator) {
      case 'greater':
        satisfied = currentPrice > threshold;
        confidence = this.calculateConfidenceForThreshold(currentPrice, threshold, 'greater');
        break;
      
      case 'less':
        satisfied = currentPrice < threshold;
        confidence = this.calculateConfidenceForThreshold(currentPrice, threshold, 'less');
        break;
      
      case 'equal':
        satisfied = Math.abs(currentPrice - threshold) < 0.0001;
        confidence = satisfied ? 1.0 : 0.0;
        break;
      
      case 'cross_above':
        satisfied = previousPrice <= threshold && currentPrice > threshold;
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      case 'cross_below':
        satisfied = previousPrice >= threshold && currentPrice < threshold;
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      default:
        throw new Error(`Unknown operator: ${condition.operator}`);
    }

    return {
      condition,
      satisfied,
      confidence,
      details: {
        currentPrice,
        previousPrice,
        threshold
      }
    };
  }

  /**
   * Evaluate a volume-based condition
   */
  private evaluateVolumeCondition(
    condition: StrategyCondition,
    recentTrades: any[]
  ): {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  } {
    // Calculate current volume from recent trades
    const currentVolume = recentTrades.slice(0, 10).reduce((sum, trade) => sum + trade.quantity, 0);
    
    // Calculate previous period volume for comparison
    const previousVolume = recentTrades.slice(10, 20).reduce((sum, trade) => sum + trade.quantity, 0);
    
    let satisfied = false;
    let confidence = 0.8;
    let threshold: number;

    if (typeof condition.value === 'string' && condition.value.includes('%')) {
      // Percentage change from previous volume
      const percentChange = parseFloat(condition.value.replace('%', ''));
      threshold = previousVolume * (1 + percentChange / 100);
    } else {
      // Absolute volume threshold
      threshold = parseFloat(condition.value.toString());
    }

    switch (condition.operator) {
      case 'greater':
        satisfied = currentVolume > threshold;
        confidence = this.calculateConfidenceForThreshold(currentVolume, threshold, 'greater');
        break;
      
      case 'less':
        satisfied = currentVolume < threshold;
        confidence = this.calculateConfidenceForThreshold(currentVolume, threshold, 'less');
        break;
      
      case 'equal':
        satisfied = Math.abs(currentVolume - threshold) < threshold * 0.01; // 1% tolerance
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      case 'cross_above':
        satisfied = previousVolume <= threshold && currentVolume > threshold;
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      case 'cross_below':
        satisfied = previousVolume >= threshold && currentVolume < threshold;
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      default:
        throw new Error(`Unknown operator: ${condition.operator}`);
    }

    return {
      condition,
      satisfied,
      confidence,
      details: {
        currentVolume,
        previousVolume,
        threshold
      }
    };
  }

  /**
   * Evaluate an order book-based condition
   */
  private evaluateOrderBookCondition(
    condition: StrategyCondition,
    orderBook: any
  ): {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  } {
    // Extract parameters from condition
    const { parameters } = condition;
    const metric = parameters?.metric || 'imbalance';
    let metricValue: number;
    let satisfied = false;
    let confidence = 0.8;
    let threshold = parseFloat(condition.value.toString());

    // Calculate the requested metric
    switch (metric) {
      case 'imbalance':
        // Calculate bid/ask imbalance ratio
        const totalBidVolume = orderBook.bids.reduce((sum: number, level: any) => sum + level.quantity, 0);
        const totalAskVolume = orderBook.asks.reduce((sum: number, level: any) => sum + level.quantity, 0);
        metricValue = (totalBidVolume - totalAskVolume) / (totalBidVolume + totalAskVolume);
        break;
      
      case 'spread':
        // Calculate spread as percentage of mid price
        const bestBid = orderBook.bids[0]?.price || 0;
        const bestAsk = orderBook.asks[0]?.price || 0;
        const midPrice = (bestBid + bestAsk) / 2;
        metricValue = ((bestAsk - bestBid) / midPrice) * 100; // Spread as percentage
        break;
      
      case 'depth':
        // Calculate depth at specified levels
        const levels = parameters?.levels || 5;
        const bidDepth = orderBook.bids.slice(0, levels).reduce((sum: number, level: any) => sum + level.quantity, 0);
        const askDepth = orderBook.asks.slice(0, levels).reduce((sum: number, level: any) => sum + level.quantity, 0);
        metricValue = bidDepth / askDepth; // Bid/ask depth ratio
        break;
      
      case 'pressure':
        // Calculate buying/selling pressure using weighted volumes
        const bidPressure = orderBook.bids.slice(0, 5).reduce((sum: number, level: any, i: number) => sum + level.quantity * (5 - i), 0);
        const askPressure = orderBook.asks.slice(0, 5).reduce((sum: number, level: any, i: number) => sum + level.quantity * (5 - i), 0);
        metricValue = bidPressure / askPressure;
        break;
      
      default:
        throw new Error(`Unknown order book metric: ${metric}`);
    }

    // Evaluate based on operator
    switch (condition.operator) {
      case 'greater':
        satisfied = metricValue > threshold;
        confidence = this.calculateConfidenceForThreshold(metricValue, threshold, 'greater');
        break;
      
      case 'less':
        satisfied = metricValue < threshold;
        confidence = this.calculateConfidenceForThreshold(metricValue, threshold, 'less');
        break;
      
      case 'equal':
        satisfied = Math.abs(metricValue - threshold) < threshold * 0.05; // 5% tolerance
        confidence = satisfied ? 0.9 : 0.0;
        break;
      
      case 'cross_above':
        // We don't have previous values for order book metrics in this implementation
        // So we approximate using a random boolean for demonstration
        satisfied = Math.random() > 0.5 && metricValue > threshold;
        confidence = satisfied ? 0.7 : 0.0; // Lower confidence due to approximation
        break;
      
      case 'cross_below':
        // We don't have previous values for order book metrics in this implementation
        // So we approximate using a random boolean for demonstration
        satisfied = Math.random() > 0.5 && metricValue < threshold;
        confidence = satisfied ? 0.7 : 0.0; // Lower confidence due to approximation
        break;
      
      default:
        throw new Error(`Unknown operator: ${condition.operator}`);
    }

    return {
      condition,
      satisfied,
      confidence,
      details: {
        metric,
        metricValue,
        threshold
      }
    };
  }

  /**
   * Evaluate a sentiment-based condition
   */
  private evaluateSentimentCondition(
    condition: StrategyCondition
  ): {
    condition: StrategyCondition;
    satisfied: boolean;
    confidence: number;
    details?: any;
  } {
    // In a real implementation, this would call an external sentiment API
    // For this example, we'll generate a random sentiment score
    const sentimentScore = Math.random() * 2 - 1; // Range: -1 to 1
    const threshold = parseFloat(condition.value.toString());
    let satisfied = false;
    let confidence = 0.7; // Lower base confidence for sentiment analysis

    switch (condition.operator) {
      case 'greater':
        satisfied = sentimentScore > threshold;
        confidence = this.calculateConfidenceForThreshold(sentimentScore, threshold, 'greater', 0.7);
        break;
      
      case 'less':
        satisfied = sentimentScore < threshold;
        confidence = this.calculateConfidenceForThreshold(sentimentScore, threshold, 'less', 0.7);
        break;
      
      case 'equal':
        satisfied = Math.abs(sentimentScore - threshold) < 0.1; // Wider tolerance for sentiment
        confidence = satisfied ? 0.7 : 0.0;
        break;
      
      case 'cross_above':
        // Approximated for demonstration
        satisfied = Math.random() > 0.7 && sentimentScore > threshold;
        confidence = satisfied ? 0.6 : 0.0;
        break;
      
      case 'cross_below':
        // Approximated for demonstration
        satisfied = Math.random() > 0.7 && sentimentScore < threshold;
        confidence = satisfied ? 0.6 : 0.0;
        break;
      
      default:
        throw new Error(`Unknown operator: ${condition.operator}`);
    }

    return {
      condition,
      satisfied,
      confidence,
      details: {
        sentimentScore,
        threshold,
        source: 'simulated' // Would be a real source in production
      }
    };
  }

  /**
   * Calculate confidence score based on how far a value is from a threshold
   */
  private calculateConfidenceForThreshold(
    value: number, 
    threshold: number, 
    direction: 'greater' | 'less',
    baseConfidence: number = 0.8
  ): number {
    // Calculate how far the value is from the threshold
    const difference = direction === 'greater' ? value - threshold : threshold - value;
    
    // If condition is not satisfied, confidence is 0
    if (difference <= 0) return 0;
    
    // Calculate relative difference as a percentage of the threshold
    const relativeDifference = difference / Math.abs(threshold);
    
    // Scale the confidence based on the relative difference
    // The further from the threshold, the higher the confidence
    const scaledConfidence = baseConfidence + (1 - baseConfidence) * Math.min(relativeDifference * 5, 1);
    
    return scaledConfidence;
  }

  /**
   * Calculate overall score from condition evaluations
   */
  private calculateOverallScore(
    evaluations: Array<{
      condition: StrategyCondition;
      satisfied: boolean;
      confidence: number;
    }>
  ): number {
    if (evaluations.length === 0) return 0;
    
    // Count satisfied conditions with their confidence
    let weightedSatisfiedCount = 0;
    
    for (const evaluation of evaluations) {
      if (evaluation.satisfied) {
        weightedSatisfiedCount += evaluation.confidence;
      }
    }
    
    // Calculate overall score (0 to 1)
    return weightedSatisfiedCount / evaluations.length;
  }

  /**
   * Determine recommendation based on entry/exit scores and AI predictions
   */
  private determineRecommendation(
    entryScore: number,
    exitScore: number,
    aiPrediction: any,
    sentimentAnalysis: any,
    anomalyDetection: any
  ): 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell' {
    // Calculate base score from entry and exit evaluations
    // Range: -1 (strong sell) to 1 (strong buy)
    let baseScore = entryScore - exitScore;
    
    // Factor in AI prediction
    // If AI predicts a price increase, boost buy signal; otherwise, boost sell signal
    const predictionFactor = (aiPrediction.predictedPrice / aiPrediction.currentPrice - 1) * 5;
    baseScore += predictionFactor * aiPrediction.confidence;
    
    // Factor in sentiment
    baseScore += sentimentAnalysis.sentiment * 0.3;
    
    // Reduce confidence if anomalies detected
    if (anomalyDetection.anomalyScore > 0.7) {
      baseScore *= (1 - anomalyDetection.anomalyScore * 0.5);
    }
    
    // Determine recommendation based on final score
    if (baseScore > 0.6) return 'strong_buy';
    if (baseScore > 0.2) return 'buy';
    if (baseScore > -0.2) return 'neutral';
    if (baseScore > -0.6) return 'sell';
    return 'strong_sell';
  }

  /**
   * Calculate suggested parameters for trade execution
   */
  private calculateSuggestedParameters(
    strategy: Strategy,
    currentPrice: number,
    recommendation: string,
    aiPrediction: any
  ): {
    entryPrice?: number;
    exitPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    positionSize?: number;
  } {
    // Only provide suggestions for buy or sell recommendations
    if (recommendation === 'neutral') {
      return {};
    }

    const isBuy = recommendation === 'buy' || recommendation === 'strong_buy';
    
    // Calculate stop loss and take profit based on strategy settings
    const stopLossPercent = strategy.riskManagement.stopLossPercentage;
    const takeProfitPercent = strategy.riskManagement.takeProfitPercentage;
    
    // Entry price suggestion
    // For buys: slightly above current price
    // For sells: slightly below current price
    const entryPrice = isBuy ? 
      currentPrice * 1.001 : // Small buffer for buy orders
      currentPrice * 0.999;  // Small buffer for sell orders
    
    // Stop loss price
    const stopLoss = isBuy ?
      entryPrice * (1 - stopLossPercent / 100) :
      entryPrice * (1 + stopLossPercent / 100);
    
    // Take profit target
    // Use AI prediction if available and it seems reasonable
    let takeProfit;
    
    if (aiPrediction && aiPrediction.confidence > 0.7) {
      const aiTarget = aiPrediction.predictedPrice;
      const aiPercentChange = (aiTarget / currentPrice - 1) * 100;
      
      if ((isBuy && aiPercentChange > 0 && aiPercentChange < takeProfitPercent * 2) ||
          (!isBuy && aiPercentChange < 0 && Math.abs(aiPercentChange) < takeProfitPercent * 2)) {
        // AI prediction is reasonable, use it
        takeProfit = aiTarget;
      } else {
        // AI prediction seems too extreme, use standard take profit
        takeProfit = isBuy ?
          entryPrice * (1 + takeProfitPercent / 100) :
          entryPrice * (1 - takeProfitPercent / 100);
      }
    } else {
      // No AI prediction or low confidence, use standard take profit
      takeProfit = isBuy ?
        entryPrice * (1 + takeProfitPercent / 100) :
        entryPrice * (1 - takeProfitPercent / 100);
    }
    
    // Position size based on risk management
    // Calculate position size to risk X% of account on each trade
    const riskPercentage = recommendation === 'strong_buy' || recommendation === 'strong_sell' ? 2 : 1;
    const accountBalance = 10000; // This would come from user's account in a real implementation
    const riskAmount = accountBalance * (riskPercentage / 100);
    
    // Risk per unit (difference between entry and stop loss)
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    
    // Position size in units (e.g., BTC)
    const positionSize = riskAmount / riskPerUnit;
    
    // Limit position size based on strategy's max position size
    const maxPositionSize = strategy.riskManagement.maxPositionSize;
    const limitedPositionSize = Math.min(positionSize, maxPositionSize);
    
    return {
      entryPrice,
      exitPrice: takeProfit,
      stopLoss,
      takeProfit,
      positionSize: limitedPositionSize
    };
  }

  /**
   * Prepare indicator data for strategy evaluation
   */
  private async prepareIndicatorData(
    strategy: Strategy,
    venue: string,
    symbol: string
  ): Promise<any> {
    // Extract indicators needed for this strategy
    const neededIndicators = new Set<string>();
    
    // Scan entry and exit conditions for required indicators
    [...strategy.entryConditions, ...strategy.exitConditions].forEach(condition => {
      if (condition.type === 'indicator' && condition.indicator) {
        neededIndicators.add(condition.indicator);
      }
    });
    
    // Fetch all required indicators
    const indicatorData: any = {};
    
    for (const indicator of neededIndicators) {
      // Determine the longest timeframe needed for this indicator
      const timeframes = strategy.timeframes.sort((a, b) => {
        // Sort timeframes by period length (e.g., 1h, 4h, 1d)
        const aValue = this.timeframeToMinutes(a);
        const bValue = this.timeframeToMinutes(b);
        return bValue - aValue; // Descending order
      });
      
      const longestTimeframe = timeframes[0] || '1h';
      
      // Fetch indicator data from the market indicators service
      const data = await this.marketIndicatorsService.getIndicator(
        venue,
        symbol,
        indicator,
        longestTimeframe
      );
      
      indicatorData[indicator] = data;
    }
    
    return indicatorData;
  }

  /**
   * Convert timeframe string to minutes
   */
  private timeframeToMinutes(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1), 10);
    
    switch (unit) {
      case 'm': return value;
      case 'h': return value * 60;
      case 'd': return value * 60 * 24;
      case 'w': return value * 60 * 24 * 7;
      default: return value;
    }
  }

  /**
   * Store evaluation results
   */
  private storeEvaluation(strategyId: string, evaluation: StrategyEvaluation): void {
    // Get existing evaluations or initialize empty array
    const evaluations = this.evaluations.get(strategyId) || [];
    
    // Add new evaluation at the beginning (most recent first)
    evaluations.unshift(evaluation);
    
    // Limit to last 100 evaluations
    if (evaluations.length > 100) {
      evaluations.pop();
    }
    
    // Update stored evaluations
    this.evaluations.set(strategyId, evaluations);
    
    // Store in Redis for persistence (in a real implementation)
    this.storeEvaluationInRedis(strategyId, evaluation);
  }

  /**
   * Store evaluation in Redis
   */
  private async storeEvaluationInRedis(strategyId: string, evaluation: StrategyEvaluation): Promise<void> {
    try {
      const key = `strategy:evaluation:${strategyId}:${evaluation.id}`;
      await this.redis.set(key, JSON.stringify(evaluation));
      await this.redis.expire(key, 60 * 60 * 24); // 24 hours TTL
      
      // Update latest evaluation reference
      await this.redis.set(`strategy:latest-evaluation:${strategyId}`, evaluation.id);
      
      // Add to time-series list
      await this.redis.lpush(`strategy:evaluations:${strategyId}`, evaluation.id);
      await this.redis.ltrim(`strategy:evaluations:${strategyId}`, 0, 99); // Keep last 100
    } catch (error) {
      this.logger.error(`Failed to store evaluation in Redis: ${error.message}`);
    }
  }

  /**
   * Load strategies from database
   */
  private async loadStrategies(): Promise<void> {
    try {
      // In a real implementation, this would load from a database
      // For this example, we'll create a few sample strategies
      
      const sampleStrategies: Strategy[] = [
        {
          id: 'strategy-001',
          name: 'Simple Moving Average Crossover',
          description: 'Buy when 10-period SMA crosses above 20-period SMA, sell when it crosses below',
          creator: 'system',
          parameters: {
            fastPeriod: 10,
            slowPeriod: 20
          },
          entryConditions: [
            {
              type: 'indicator',
              indicator: 'SMA',
              operator: 'cross_above',
              value: '$SMA(20)',
              parameters: { period: 10 }
            }
          ],
          exitConditions: [
            {
              type: 'indicator',
              indicator: 'SMA',
              operator: 'cross_below',
              value: '$SMA(20)',
              parameters: { period: 10 }
            }
          ],
          riskManagement: {
            maxPositionSize: 1.0,
            maxDrawdown: 5.0,
            stopLossPercentage: 2.0,
            takeProfitPercentage: 5.0
          },
          timeframes: ['1h', '4h'],
          markets: [
            { venue: 'BINANCE', symbol: 'BTC-USDT' },
            { venue: 'BINANCE', symbol: 'ETH-USDT' }
          ],
          status: 'active'
        },
        {
          id: 'strategy-002',
          name: 'RSI Oversold/Overbought',
          description: 'Buy when RSI is oversold, sell when overbought',
          creator: 'system',
          parameters: {
            rsiPeriod: 14,
            oversoldThreshold: 30,
            overboughtThreshold: 70
          },
          entryConditions: [
            {
              type: 'indicator',
              indicator: 'RSI',
              operator: 'less',
              value: 30,
              parameters: { period: 14 }
            }
          ],
          exitConditions: [
            {
              type: 'indicator',
              indicator: 'RSI',
              operator: 'greater',
              value: 70,
              parameters: { period: 14 }
            }
          ],
          riskManagement: {
            maxPositionSize: 0.5,
            maxDrawdown: 3.0,
            stopLossPercentage: 1.5,
            takeProfitPercentage: 4.0
          },
          timeframes: ['15m', '1h'],
          markets: [
            { venue: 'COINBASE', symbol: 'BTC-USD' },
            { venue: 'COINBASE', symbol: 'ETH-USD' }
          ],
          status: 'active'
        }
      ];
      
      // Store sample strategies
      for (const strategy of sampleStrategies) {
        this.strategies.set(strategy.id, strategy);
      }
      
      this.logger.info(`Loaded ${sampleStrategies.length} strategies`);
    } catch (error) {
      this.logger.error(`Failed to load strategies: ${error.message}`);
      throw error;
    }
  }

  /**
   * Subscribe to strategy-related events
   */
  private subscribeToEvents(): void {
    // Subscribe to strategy updates
    this.eventEmitter.on('strategy:created', async (data) => {
      try {
        const strategy = data.strategy;
        await this.registerStrategy(strategy);
      } catch (error) {
        this.logger.error(`Error handling strategy:created event: ${error.message}`);
      }
    });
    
    // Subscribe to strategy updates
    this.eventEmitter.on('strategy:updated', async (data) => {
      try {
        const { strategyId, updates } = data;
        await this.updateStrategy(strategyId, updates);
      } catch (error) {
        this.logger.error(`Error handling strategy:updated event: ${error.message}`);
      }
    });
    
    // Subscribe to strategy deletions
    this.eventEmitter.on('strategy:deleted', async (data) => {
      try {
        const { strategyId } = data;
        await this.deleteStrategy(strategyId);
      } catch (error) {
        this.logger.error(`Error handling strategy:deleted event: ${error.message}`);
      }
    });
  }

  /**
   * Validate a strategy configuration
   */
  private validateStrategy(strategy: Strategy): void {
    // Ensure required fields are present
    if (!strategy.id) throw new Error('Strategy ID is required');
    if (!strategy.name) throw new Error('Strategy name is required');
    if (!strategy.entryConditions || strategy.entryConditions.length === 0) {
      throw new Error('At least one entry condition is required');
    }
    if (!strategy.markets || strategy.markets.length === 0) {
      throw new Error('At least one market configuration is required');
    }
    
    // Validate entry and exit conditions
    [...strategy.entryConditions, ...strategy.exitConditions].forEach(condition => {
      if (!condition.type) throw new Error('Condition type is required');
      if (!condition.operator) throw new Error('Condition operator is required');
      if (condition.value === undefined) throw new Error('Condition value is required');
      
      // Validate indicator conditions
      if (condition.type === 'indicator' && !condition.indicator) {
        throw new Error('Indicator name is required for indicator conditions');
      }
    });
    
    // Validate risk management settings
    if (!strategy.riskManagement) throw new Error('Risk management settings are required');
    if (strategy.riskManagement.stopLossPercentage <= 0) {
      throw new Error('Stop loss percentage must be greater than 0');
    }
    if (strategy.riskManagement.takeProfitPercentage <= 0) {
      throw new Error('Take profit percentage must be greater than 0');
    }
    
    // Validate timeframes
    if (!strategy.timeframes || strategy.timeframes.length === 0) {
      throw new Error('At least one timeframe is required');
    }
  }

  /**
   * Save strategy to database (placeholder)
   */
  private async saveStrategyToDatabase(strategy: Strategy): Promise<void> {
    // In a real implementation, this would save to a database
    // For this example, we'll just simulate a delay
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  /**
   * Delete strategy from database (placeholder)
   */
  private async deleteStrategyFromDatabase(strategyId: string): Promise<void> {
    // In a real implementation, this would delete from a database
    // For this example, we'll just simulate a delay
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}