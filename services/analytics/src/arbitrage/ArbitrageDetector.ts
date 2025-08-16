              // Calculate confidence score based on:
              // - Volume liquidity on both venues
              // - Historical price stability
              // - Venue reliability
              // - Time since order book update
              const volumeLiquidity = Math.min(
                buyOrderBook.asks.reduce((sum, level) => sum + level.quantity, 0),
                sellOrderBook.bids.reduce((sum, level) => sum + level.quantity, 0)
              ) / (maxVolume * 10); // Normalize
              
              const priceStability = await this.getPriceStabilityScore(symbol);
              const venueReliability = (this.getVenueReliabilityScore(buyVenue) + 
                                        this.getVenueReliabilityScore(sellVenue)) / 2;
              const orderBookFreshness = Math.min(
                Math.max(0, 1 - (Date.now() - buyOrderBook.timestamp) / 10000),
                Math.max(0, 1 - (Date.now() - sellOrderBook.timestamp) / 10000)
              );
              
              const confidence = (
                volumeLiquidity * 0.3 +
                priceStability * 0.3 +
                venueReliability * 0.2 +
                orderBookFreshness * 0.2
              );
              
              // Only consider opportunities with:
              // - Positive estimated profit
              // - Profit percentage above threshold
              // - Confidence above threshold
              // - Execution time below maximum
              if (estimatedProfit > 0 &&
                  estimatedProfitPercentage >= this.minProfitPercentage &&
                  confidence >= this.confidenceThreshold &&
                  estimatedTime <= this.maxExecutionTime) {
                  
                // Generate unique ID for this opportunity
                const opportunityId = `arb_${buyVenue}_${sellVenue}_${symbol}_${Date.now()}`;
                
                const opportunity: ArbitrageOpportunity = {
                  id: opportunityId,
                  timestamp: Date.now(),
                  buyVenue,
                  sellVenue,
                  symbol,
                  buyPrice,
                  sellPrice,
                  spread,
                  spreadPercentage,
                  maxVolume,
                  estimatedProfit,
                  estimatedProfitPercentage,
                  buyFee,
                  sellFee,
                  transferFee,
                  estimatedTime,
                  confidence,
                  status: 'open'
                };
                
                // Store the opportunity
                this.opportunities.set(opportunityId, opportunity);
                
                // Publish event
                this.eventEmitter.emit('arbitrage:opportunity', opportunity);
                
                // Log the opportunity
                this.logger.info(`Found arbitrage opportunity: ${symbol} - Buy at ${buyVenue} (${buyPrice}), Sell at ${sellVenue} (${sellPrice}), Profit: ${estimatedProfitPercentage.toFixed(4)}%, Volume: ${maxVolume}`);
              }
            }
          }
        }
      } catch (error) {
        this.logger.error(`Error checking arbitrage for ${symbol}: ${error.message}`);
      }
    }
    
    // Check existing opportunities to see if they're still valid
    await this.updateExistingOpportunities();
  }
  
  /**
   * Update status of existing opportunities
   */
  private async updateExistingOpportunities(): Promise<void> {
    const now = Date.now();
    const opportunitiesToCheck = Array.from(this.opportunities.values())
      .filter(opp => opp.status === 'open');
      
    for (const opportunity of opportunitiesToCheck) {
      try {
        // Get current order books
        const buyOrderBook = await this.orderBookService.getOrderBook(
          opportunity.buyVenue, 
          opportunity.symbol
        );
        
        const sellOrderBook = await this.orderBookService.getOrderBook(
          opportunity.sellVenue, 
          opportunity.symbol
        );
        
        // Skip if any order book is missing
        if (!buyOrderBook || !sellOrderBook) {
          continue;
        }
        
        // Get current best prices
        const currentBuyPrice = buyOrderBook.asks[0]?.price;
        const currentSellPrice = sellOrderBook.bids[0]?.price;
        
        // If opportunity no longer exists, mark it as closed
        if (!currentBuyPrice || !currentSellPrice || currentSellPrice <= currentBuyPrice) {
          opportunity.status = 'closed';
          this.eventEmitter.emit('arbitrage:closed', opportunity);
          this.logger.info(`Arbitrage opportunity closed: ${opportunity.id}`);
          continue;
        }
        
        // Update opportunity with current values
        const spread = currentSellPrice - currentBuyPrice;
        const spreadPercentage = (spread / currentBuyPrice) * 100;
        
        // Get maximum possible volume
        const maxBuyVolume = buyOrderBook.asks[0].quantity;
        const maxSellVolume = sellOrderBook.bids[0].quantity;
        const maxVolume = Math.min(maxBuyVolume, maxSellVolume);
        
        // Update fees
        const buyVenueInfo = this.venueInfoCache.get(opportunity.buyVenue);
        const sellVenueInfo = this.venueInfoCache.get(opportunity.sellVenue);
        
        if (!buyVenueInfo || !sellVenueInfo) {
          continue;
        }
        
        const buyFee = (currentBuyPrice * maxVolume) * (buyVenueInfo.takerFee / 100);
        const sellFee = (currentSellPrice * maxVolume) * (sellVenueInfo.takerFee / 100);
        
        // Calculate estimated profit
        const grossProfit = (currentSellPrice - currentBuyPrice) * maxVolume;
        const totalFees = buyFee + sellFee + opportunity.transferFee;
        const estimatedProfit = grossProfit - totalFees;
        const estimatedProfitPercentage = (estimatedProfit / (currentBuyPrice * maxVolume)) * 100;
        
        // Update opportunity
        opportunity.buyPrice = currentBuyPrice;
        opportunity.sellPrice = currentSellPrice;
        opportunity.spread = spread;
        opportunity.spreadPercentage = spreadPercentage;
        opportunity.maxVolume = maxVolume;
        opportunity.estimatedProfit = estimatedProfit;
        opportunity.estimatedProfitPercentage = estimatedProfitPercentage;
        opportunity.buyFee = buyFee;
        opportunity.sellFee = sellFee;
        
        // Check if opportunity is still profitable
        if (estimatedProfit <= 0 || estimatedProfitPercentage < this.minProfitPercentage) {
          opportunity.status = 'closed';
          this.eventEmitter.emit('arbitrage:closed', opportunity);
          this.logger.info(`Arbitrage opportunity closed (no longer profitable): ${opportunity.id}`);
        }
      } catch (error) {
        this.logger.error(`Error updating opportunity ${opportunity.id}: ${error.message}`);
      }
    }
    
    // Remove old closed opportunities after 1 hour
    const cutoffTime = now - 3600000; // 1 hour in milliseconds
    for (const [id, opportunity] of this.opportunities.entries()) {
      if (opportunity.status !== 'open' && opportunity.timestamp < cutoffTime) {
        this.opportunities.delete(id);
      }
    }
  }
  
  /**
   * Load venue information from database or configuration
   */
  private async loadVenueInfo(): Promise<void> {
    try {
      // In a real implementation, this would load from a database
      // For now, we'll use some example values
      
      this.venueInfoCache.set('BINANCE', {
        venue: 'BINANCE',
        takerFee: 0.1,
        minNotional: 10,
        withdrawalFee: {
          'BTC': 0.0005,
          'ETH': 0.005,
          'USDT': 20
        },
        depositTime: {
          'BTC': 60 * 30, // 30 minutes
          'ETH': 60 * 15, // 15 minutes
          'USDT': 60 * 5   // 5 minutes
        },
        withdrawalTime: {
          'BTC': 60 * 60, // 60 minutes
          'ETH': 60 * 30, // 30 minutes
          'USDT': 60 * 10  // 10 minutes
        },
        status: 'active'
      });
      
      this.venueInfoCache.set('COINBASE', {
        venue: 'COINBASE',
        takerFee: 0.3,
        minNotional: 10,
        withdrawalFee: {
          'BTC': 0.0003,
          'ETH': 0.003,
          'USDT': 10
        },
        depositTime: {
          'BTC': 60 * 45, // 45 minutes
          'ETH': 60 * 20, // 20 minutes
          'USDT': 60 * 5   // 5 minutes
        },
        withdrawalTime: {
          'BTC': 60 * 90, // 90 minutes
          'ETH': 60 * 45, // 45 minutes
          'USDT': 60 * 15  // 15 minutes
        },
        status: 'active'
      });
      
      this.venueInfoCache.set('KRAKEN', {
        venue: 'KRAKEN',
        takerFee: 0.26,
        minNotional: 10,
        withdrawalFee: {
          'BTC': 0.0005,
          'ETH': 0.005,
          'USDT': 15
        },
        depositTime: {
          'BTC': 60 * 40, // 40 minutes
          'ETH': 60 * 20, // 20 minutes
          'USDT': 60 * 10  // 10 minutes
        },
        withdrawalTime: {
          'BTC': 60 * 75, // 75 minutes
          'ETH': 60 * 40, // 40 minutes
          'USDT': 60 * 20  // 20 minutes
        },
        status: 'active'
      });
      
      this.logger.info(`Loaded information for ${this.venueInfoCache.size} venues`);
    } catch (error) {
      this.logger.error(`Error loading venue information: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get price stability score for a symbol
   * 0 = very volatile, 1 = very stable
   */
  private async getPriceStabilityScore(symbol: string): Promise<number> {
    try {
      // In a real implementation, this would analyze recent price history
      // For now, return a random value between 0.7 and 1.0
      return 0.7 + Math.random() * 0.3;
    } catch (error) {
      this.logger.error(`Error getting price stability score: ${error.message}`);
      return 0.5; // Default middle value
    }
  }
  
  /**
   * Get reliability score for a venue
   * 0 = unreliable, 1 = very reliable
   */
  private getVenueReliabilityScore(venue: string): number {
    // In a real implementation, this would consider:
    // - Historical uptime
    // - API stability
    // - Order execution quality
    // - Settlement speed
    
    // For now, use hardcoded values
    const scores: Record<string, number> = {
      'BINANCE': 0.95,
      'COINBASE': 0.93,
      'KRAKEN': 0.91,
      'BITFINEX': 0.89,
      'HUOBI': 0.87,
      'BYBIT': 0.85,
      'KUCOIN': 0.83
    };
    
    return scores[venue] || 0.8; // Default value for unknown venues
  }
}