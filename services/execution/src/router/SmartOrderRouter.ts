import { Logger } from '../utils/Logger';
import { OrderService } from '../services/OrderService';
import { VenueAdapter } from '../adapters/VenueAdapter';
import { OrderBook } from '../types/OrderBook';
import { Order, OrderType, OrderSide, OrderStatus, SmartOrder } from '../types/Order';
import { MarketDataService } from '../services/MarketDataService';
import { VenueRegistry } from '../registry/VenueRegistry';
import { ExecutionVenue } from '../types/Venue';
import { AlgorithmRegistry } from '../registry/AlgorithmRegistry';
import { ExecutionAlgorithm } from '../algorithms/ExecutionAlgorithm';
import { v4 as uuidv4 } from 'uuid';

export class SmartOrderRouter {
  private logger: Logger;
  private orderService: OrderService;
  private marketDataService: MarketDataService;
  private venueRegistry: VenueRegistry;
  private algorithmRegistry: AlgorithmRegistry;
  private activeSmartOrders: Map<string, SmartOrder>;
  
  constructor(
    orderService: OrderService,
    marketDataService: MarketDataService,
    venueRegistry: VenueRegistry,
    algorithmRegistry: AlgorithmRegistry
  ) {
    this.logger = new Logger('SmartOrderRouter');
    this.orderService = orderService;
    this.marketDataService = marketDataService;
    this.venueRegistry = venueRegistry;
    this.algorithmRegistry = algorithmRegistry;
    this.activeSmartOrders = new Map<string, SmartOrder>();
    
    // Initialize order status subscription
    this.subscribeToOrderUpdates();
  }
  
  /**
   * Routes a smart order across multiple venues based on liquidity, fees, and execution preferences
   */
  public async routeOrder(smartOrder: SmartOrder): Promise<string> {
    try {
      this.logger.info(`Routing smart order ${smartOrder.id} for ${smartOrder.symbol}`);
      
      // Generate a new ID if not provided
      if (!smartOrder.id) {
        smartOrder.id = uuidv4();
      }
      
      // Set initial status
      smartOrder.status = OrderStatus.PENDING;
      smartOrder.createdAt = new Date().toISOString();
      smartOrder.childOrders = [];
      
      // Validate the order
      this.validateSmartOrder(smartOrder);
      
      // Store the smart order
      this.activeSmartOrders.set(smartOrder.id, smartOrder);
      
      // Get suitable venues
      const venues = await this.selectVenues(smartOrder);
      
      // Select execution algorithm
      const algorithm = this.algorithmRegistry.getAlgorithm(smartOrder.algorithm);
      
      // Initialize the algorithm with this order
      algorithm.initialize(smartOrder, venues);
      
      // Start execution
      this.executeNextSlice(smartOrder.id, algorithm);
      
      return smartOrder.id;
    } catch (error) {
      this.logger.error(`Error routing order: ${error}`);
      throw error;
    }
  }
  
  /**
   * Execute the next slice of the smart order using the selected algorithm
   */
  private async executeNextSlice(smartOrderId: string, algorithm: ExecutionAlgorithm): Promise<void> {
    const smartOrder = this.activeSmartOrders.get(smartOrderId);
    if (!smartOrder || smartOrder.status === OrderStatus.COMPLETED || smartOrder.status === OrderStatus.CANCELED) {
      return;
    }
    
    try {
      // Update smart order status
      smartOrder.status = OrderStatus.IN_PROGRESS;
      
      // Get the next slice from the algorithm
      const slice = await algorithm.getNextSlice();
      
      if (!slice) {
        // No more slices - check if we're done
        this.checkOrderCompletion(smartOrderId);
        return;
      }
      
      // Create child order for this slice
      const childOrder: Order = {
        id: uuidv4(),
        parentId: smartOrderId,
        clientId: smartOrder.clientId,
        symbol: smartOrder.symbol,
        side: smartOrder.side,
        type: slice.orderType || OrderType.LIMIT,
        quantity: slice.quantity,
        price: slice.price,
        venue: slice.venue,
        status: OrderStatus.PENDING,
        createdAt: new Date().toISOString()
      };
      
      // Add to child orders
      smartOrder.childOrders.push(childOrder);
      
      // Get venue adapter
      const venueAdapter = this.venueRegistry.getVenueAdapter(slice.venue);
      
      // Submit the order to the venue
      const orderId = await venueAdapter.submitOrder(childOrder);
      childOrder.id = orderId || childOrder.id;
      
      // Update status
      this.updateSmartOrderStatus(smartOrderId);
      
      // Schedule next evaluation
      setTimeout(() => {
        this.executeNextSlice(smartOrderId, algorithm);
      }, algorithm.getNextEvaluationTime());
      
    } catch (error) {
      this.logger.error(`Error executing slice for order ${smartOrderId}: ${error}`);
      smartOrder.lastError = `${error}`;
      this.updateSmartOrderStatus(smartOrderId);
    }
  }
  
  /**
   * Check if a smart order is complete
   */
  private checkOrderCompletion(smartOrderId: string): void {
    const smartOrder = this.activeSmartOrders.get(smartOrderId);
    if (!smartOrder) return;
    
    const totalExecuted = smartOrder.childOrders.reduce(
      (sum, order) => sum + (order.executedQuantity || 0), 
      0
    );
    
    if (totalExecuted >= smartOrder.quantity) {
      // Order is fully executed
      smartOrder.status = OrderStatus.COMPLETED;
      smartOrder.completedAt = new Date().toISOString();
    } else if (smartOrder.status !== OrderStatus.CANCELED) {
      // Still pending completion
      smartOrder.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    // Update the order
    this.activeSmartOrders.set(smartOrderId, smartOrder);
  }
  
  /**
   * Update the status of a smart order based on its child orders
   */
  private updateSmartOrderStatus(smartOrderId: string): void {
    const smartOrder = this.activeSmartOrders.get(smartOrderId);
    if (!smartOrder) return;
    
    // Calculate total executed quantity
    const totalExecuted = smartOrder.childOrders.reduce(
      (sum, order) => sum + (order.executedQuantity || 0), 
      0
    );
    
    smartOrder.executedQuantity = totalExecuted;
    
    // Determine status
    if (totalExecuted === 0) {
      smartOrder.status = OrderStatus.IN_PROGRESS;
    } else if (totalExecuted < smartOrder.quantity) {
      smartOrder.status = OrderStatus.PARTIALLY_FILLED;
    } else {
      smartOrder.status = OrderStatus.COMPLETED;
      smartOrder.completedAt = new Date().toISOString();
    }
    
    // Calculate average execution price
    if (totalExecuted > 0) {
      const totalValue = smartOrder.childOrders.reduce(
        (sum, order) => sum + ((order.executedQuantity || 0) * (order.executedPrice || order.price || 0)), 
        0
      );
      
      smartOrder.executedPrice = totalValue / totalExecuted;
    }
    
    // Update the order
    this.activeSmartOrders.set(smartOrderId, smartOrder);
  }
  
  /**
   * Cancel a smart order and all its child orders
   */
  public async cancelSmartOrder(smartOrderId: string): Promise<boolean> {
    const smartOrder = this.activeSmartOrders.get(smartOrderId);
    if (!smartOrder) {
      throw new Error(`Smart order ${smartOrderId} not found`);
    }
    
    // Already canceled or completed
    if (smartOrder.status === OrderStatus.CANCELED || smartOrder.status === OrderStatus.COMPLETED) {
      return false;
    }
    
    try {
      // Cancel all active child orders
      const cancelPromises = smartOrder.childOrders
        .filter(order => 
          order.status !== OrderStatus.COMPLETED && 
          order.status !== OrderStatus.CANCELED &&
          order.status !== OrderStatus.REJECTED
        )
        .map(async (order) => {
          const venueAdapter = this.venueRegistry.getVenueAdapter(order.venue);
          return venueAdapter.cancelOrder(order.id);
        });
      
      await Promise.all(cancelPromises);
      
      // Update smart order status
      smartOrder.status = OrderStatus.CANCELED;
      smartOrder.canceledAt = new Date().toISOString();
      
      // Update the order
      this.activeSmartOrders.set(smartOrderId, smartOrder);
      
      return true;
    } catch (error) {
      this.logger.error(`Error canceling smart order ${smartOrderId}: ${error}`);
      throw error;
    }
  }
  
  /**
   * Select the best venues for order execution based on liquidity and fees
   */
  private async selectVenues(smartOrder: SmartOrder): Promise<ExecutionVenue[]> {
    // Get all venues that support this symbol
    const allVenues = this.venueRegistry.getVenuesForSymbol(smartOrder.symbol);
    
    // Filter based on client permissions
    const allowedVenues = allVenues.filter(venue => 
      this.hasVenuePermission(smartOrder.clientId, venue.id)
    );
    
    if (allowedVenues.length === 0) {
      throw new Error(`No venues available for ${smartOrder.symbol}`);
    }
    
    // If venues are explicitly specified in the order, use those
    if (smartOrder.venues && smartOrder.venues.length > 0) {
      const specifiedVenues = allowedVenues.filter(venue => 
        smartOrder.venues!.includes(venue.id)
      );
      
      if (specifiedVenues.length === 0) {
        throw new Error(`None of the specified venues are available for ${smartOrder.symbol}`);
      }
      
      return specifiedVenues;
    }
    
    // Otherwise, rank venues by liquidity and fees
    const venuesWithLiquidity = await this.rankVenuesByLiquidity(
      allowedVenues,
      smartOrder.symbol,
      smartOrder.side,
      smartOrder.quantity
    );
    
    return venuesWithLiquidity;
  }
  
  /**
   * Rank venues by available liquidity and estimated execution cost
   */
  private async rankVenuesByLiquidity(
    venues: ExecutionVenue[],
    symbol: string,
    side: OrderSide,
    quantity: number
  ): Promise<ExecutionVenue[]> {
    try {
      // Get order books from all venues
      const orderBookPromises = venues.map(venue => 
        this.marketDataService.getOrderBook(venue.id, symbol)
      );
      
      const orderBooks = await Promise.all(orderBookPromises);
      
      // Calculate available liquidity and estimated cost for each venue
      const venuesWithMetrics = venues.map((venue, index) => {
        const orderBook = orderBooks[index];
        const liquidity = this.calculateAvailableLiquidity(orderBook, side);
        const estimatedCost = this.estimateExecutionCost(orderBook, side, quantity, venue.fees);
        
        return {
          venue,
          liquidity,
          estimatedCost,
          // Score = liquidity available / cost to execute (higher is better)
          score: liquidity > 0 ? (liquidity / estimatedCost) : 0
        };
      });
      
      // Sort by score (descending)
      venuesWithMetrics.sort((a, b) => b.score - a.score);
      
      // Return sorted venues
      return venuesWithMetrics.map(item => item.venue);
    } catch (error) {
      this.logger.error(`Error ranking venues by liquidity: ${error}`);
      // Fall back to original order if ranking fails
      return venues;
    }
  }
  
  /**
   * Calculate available liquidity for a given side
   */
  private calculateAvailableLiquidity(orderBook: OrderBook, side: OrderSide): number {
    if (!orderBook) return 0;
    
    const levels = side === OrderSide.BUY ? orderBook.asks : orderBook.bids;
    
    // Sum up all available quantity
    return levels.reduce((sum, level) => sum + level.quantity, 0);
  }
  
  /**
   * Estimate the cost of executing an order at a venue
   */
  private estimateExecutionCost(
    orderBook: OrderBook, 
    side: OrderSide, 
    quantity: number,
    venueFees: number
  ): number {
    if (!orderBook) return Number.MAX_SAFE_INTEGER;
    
    const levels = side === OrderSide.BUY ? orderBook.asks : orderBook.bids;
    
    let remainingQuantity = quantity;
    let totalCost = 0;
    let totalQuantityFilled = 0;
    
    // Walk the book
    for (const level of levels) {
      const fillQuantity = Math.min(remainingQuantity, level.quantity);
      totalCost += fillQuantity * level.price;
      totalQuantityFilled += fillQuantity;
      remainingQuantity -= fillQuantity;
      
      if (remainingQuantity <= 0) break;
    }
    
    // Add venue fees
    const feeCost = totalCost * (venueFees / 100);
    totalCost += feeCost;
    
    // If we couldn't fill the full quantity, penalize the cost
    if (totalQuantityFilled < quantity) {
      // Apply penalty factor for partial fills
      const unfillablePortion = (quantity - totalQuantityFilled) / quantity;
      totalCost *= (1 + unfillablePortion);
    }
    
    return totalCost;
  }
  
  /**
   * Check if a client has permission to trade on a venue
   */
  private hasVenuePermission(clientId: string, venueId: string): boolean {
    // In a real system, this would check against a permissions database
    // For this example, we'll assume all clients have access to all venues
    return true;
  }
  
  /**
   * Validate a smart order before routing
   */
  private validateSmartOrder(order: SmartOrder): void {
    if (!order.symbol) {
      throw new Error('Order must specify a symbol');
    }
    
    if (!order.quantity || order.quantity <= 0) {
      throw new Error('Order quantity must be greater than zero');
    }
    
    if (!order.side) {
      throw new Error('Order must specify a side (BUY/SELL)');
    }
    
    if (!order.clientId) {
      throw new Error('Order must include a client ID');
    }
    
    // If it's a limit order, it must have a price
    if (order.type === OrderType.LIMIT && !order.price) {
      throw new Error('Limit orders must specify a price');
    }
  }
  
  /**
   * Subscribe to order status updates
   */
  private subscribeToOrderUpdates(): void {
    this.orderService.subscribeToOrderUpdates((update) => {
      // Find the parent smart order
      if (update.parentId && this.activeSmartOrders.has(update.parentId)) {
        const smartOrder = this.activeSmartOrders.get(update.parentId)!;
        
        // Update the child order
        const childIndex = smartOrder.childOrders.findIndex(o => o.id === update.id);
        if (childIndex >= 0) {
          smartOrder.childOrders[childIndex] = {
            ...smartOrder.childOrders[childIndex],
            ...update
          };
          
          // Update smart order status
          this.updateSmartOrderStatus(smartOrder.id);
        }
      }
    });
  }
  
  /**
   * Get details about a smart order
   */
  public getSmartOrder(smartOrderId: string): SmartOrder | undefined {
    return this.activeSmartOrders.get(smartOrderId);
  }
  
  /**
   * Get all active smart orders for a client
   */
  public getActiveSmartOrdersForClient(clientId: string): SmartOrder[] {
    return Array.from(this.activeSmartOrders.values())
      .filter(order => order.clientId === clientId)
      .filter(order => 
        order.status !== OrderStatus.COMPLETED && 
        order.status !== OrderStatus.CANCELED &&
        order.status !== OrderStatus.REJECTED
      );
  }
}