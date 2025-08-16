      const key = `cb:config:${marketId}`;
      await this.redis.set(key, JSON.stringify(config));
      
      // No expiration - configurations should persist
    } catch (error) {
      this.logger.error(`Error saving circuit breaker configuration: ${error.message}`);
    }
  }
  
  /**
   * Subscribe to relevant events
   */
  private subscribeToEvents(): void {
    // Subscribe to external circuit breaker triggers
    this.eventEmitter.on('external:circuit_breaker', async (data) => {
      try {
        const { venue, symbol, state, source, reason } = data;
        const marketId = this.getMarketId(venue, symbol);
        const config = this.configs.get(marketId);
        
        if (!config) {
          this.logger.warn(`Received external circuit breaker event for unknown market: ${marketId}`);
          return;
        }
        
        if (!config.allowExternalTriggers) {
          this.logger.warn(`External triggers not allowed for ${marketId}`);
          return;
        }
        
        // Map external state to our state
        let cbState: CircuitBreakerState;
        switch (state.toUpperCase()) {
          case 'HALT':
          case 'HALTED':
          case 'SUSPENDED':
            cbState = CircuitBreakerState.TRIPPED;
            break;
          case 'WARNING':
          case 'CAUTION':
            cbState = CircuitBreakerState.WARNING;
            break;
          case 'COOLING':
          case 'PRE_OPEN':
            cbState = CircuitBreakerState.COOLING;
            break;
          case 'NORMAL':
          case 'ACTIVE':
          case 'OPEN':
            cbState = CircuitBreakerState.NORMAL;
            break;
          default:
            cbState = CircuitBreakerState.MANUAL_OVERRIDE;
        }
        
        // Process the external trigger
        await this.manualTrigger(
          venue,
          symbol,
          cbState,
          `external:${source}`,
          reason || 'External circuit breaker event'
        );
      } catch (error) {
        this.logger.error(`Error handling external circuit breaker event: ${error.message}`);
      }
    });
    
    // Subscribe to configuration updates
    this.eventEmitter.on('config:circuit_breaker_updated', async (data) => {
      try {
        const { config } = data;
        await this.updateConfig(config);
      } catch (error) {
        this.logger.error(`Error handling circuit breaker config update: ${error.message}`);
      }
    });
  }
}