import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Tabs, Tab } from '../common/Tabs';
import { NumericInput } from '../common/NumericInput';
import { Dropdown } from '../common/Dropdown';
import { Switch } from '../common/Switch';
import { Slider } from '../common/Slider';
import { Icon } from '../common/Icon';
import { useOrderBookData } from '../../hooks/useOrderBookData';
import { useBalances } from '../../hooks/useBalances';
import { useTradeHistory } from '../../hooks/useTradeHistory';
import { useOrderService } from '../../hooks/useOrderService';
import { formatPrice, formatQuantity } from '../../utils/formatters';
import { toast } from '../../utils/toast';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

interface AdvancedOrderFormProps {
  symbol: string;
  venue: string;
  tickSize?: number;
  lotSize?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
  defaultOrderType?: 'limit' | 'market' | 'stop' | 'stopLimit';
  defaultTimeInForce?: 'gtc' | 'ioc' | 'fok';
  showOneClickTrading?: boolean;
  requireConfirmation?: boolean;
  onOrderSubmit?: (order: any) => void;
  onOrderSuccess?: (result: any) => void;
  onOrderError?: (error: any) => void;
}

export const AdvancedOrderForm: React.FC<AdvancedOrderFormProps> = ({
  symbol,
  venue,
  tickSize = 0.01,
  lotSize = 0.001,
  minOrderSize = 0.001,
  maxOrderSize = 100000,
  defaultOrderType = 'limit',
  defaultTimeInForce = 'gtc',
  showOneClickTrading = true,
  requireConfirmation = true,
  onOrderSubmit,
  onOrderSuccess,
  onOrderError
}) => {
  // State for order form
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<string>(defaultOrderType);
  const [price, setPrice] = useState<number | null>(null);
  const [stopPrice, setStopPrice] = useState<number | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [notional, setNotional] = useState<number | null>(null);
  const [timeInForce, setTimeInForce] = useState<string>(defaultTimeInForce);
  const [postOnly, setPostOnly] = useState<boolean>(false);
  const [reduceOnly, setReduceOnly] = useState<boolean>(false);
  const [isOneClickEnabled, setIsOneClickEnabled] = useState<boolean>(false);
  const [isCalculatingByTotal, setIsCalculatingByTotal] = useState<boolean>(false);
  
  // Get real-time order book data
  const { data: orderBookData, isLoading: isLoadingOrderBook } = useOrderBookData(venue, symbol);
  
  // Get account balances
  const { balances, isLoading: isLoadingBalances } = useBalances(venue);
  
  // Get recent trades
  const { trades, isLoading: isLoadingTrades } = useTradeHistory(venue, symbol, 10);
  
  // Order service for submitting orders
  const { submitOrder, isSubmitting } = useOrderService();
  
  // Confirmation dialog
  const { showConfirm } = useConfirmDialog();
  
  // Parse symbol to get base and quote assets
  const [baseAsset, quoteAsset] = symbol.split('-');
  
  // Get relevant balances
  const baseBalance = balances?.find(b => b.asset === baseAsset)?.free || 0;
  const quoteBalance = balances?.find(b => b.asset === quoteAsset)?.free || 0;
  
  // Get current best price from order book
  const bestBidPrice = orderBookData?.bids[0]?.price || null;
  const bestAskPrice = orderBookData?.asks[0]?.price || null;
  
  // Get last price from trades
  const lastPrice = trades && trades.length > 0 ? trades[0].price : null;
  
  // Adjust price and quantity to tick size and lot size
  const adjustToTickSize = (value: number): number => {
    return Math.floor(value / tickSize) * tickSize;
  };
  
  const adjustToLotSize = (value: number): number => {
    return Math.floor(value / lotSize) * lotSize;
  };
  
  // Update price based on order book or trade data
  useEffect(() => {
    if (!price && lastPrice) {
      setPrice(adjustToTickSize(lastPrice));
    }
  }, [lastPrice, price, tickSize]);
  
  // Calculate quantity from notional or vice versa
  useEffect(() => {
    if (isCalculatingByTotal) {
      if (notional !== null && price !== null && price > 0) {
        const calculatedQty = adjustToLotSize(notional / price);
        if (calculatedQty !== quantity) {
          setQuantity(calculatedQty);
        }
      }
    } else {
      if (quantity !== null && price !== null) {
        const calculatedNotional = quantity * price;
        if (calculatedNotional !== notional) {
          setNotional(calculatedNotional);
        }
      }
    }
  }, [notional, price, quantity, isCalculatingByTotal, lotSize]);
  
  // Handle price change
  const handlePriceChange = (value: number | null) => {
    if (value !== null) {
      setPrice(adjustToTickSize(value));
    } else {
      setPrice(null);
    }
  };
  
  // Handle quantity change
  const handleQuantityChange = (value: number | null) => {
    if (value !== null) {
      setQuantity(adjustToLotSize(value));
      setIsCalculatingByTotal(false);
    } else {
      setQuantity(null);
    }
  };
  
  // Handle notional (total) change
  const handleNotionalChange = (value: number | null) => {
    setNotional(value);
    setIsCalculatingByTotal(true);
  };
  
  // Handle stop price change
  const handleStopPriceChange = (value: number | null) => {
    if (value !== null) {
      setStopPrice(adjustToTickSize(value));
    } else {
      setStopPrice(null);
    }
  };
  
  // Set percentage of balance
  const handlePercentageClick = (percentage: number) => {
    if (activeTab === 'buy' && quoteBalance && price) {
      const maxBuyNotional = quoteBalance * percentage;
      handleNotionalChange(maxBuyNotional);
    } else if (activeTab === 'sell' && baseBalance) {
      const maxSellQuantity = baseBalance * percentage;
      handleQuantityChange(maxSellQuantity);
    }
  };
  
  // Use best price from order book
  const useBestPrice = (side: 'bid' | 'ask') => {
    if (side === 'bid' && bestBidPrice) {
      handlePriceChange(bestBidPrice);
    } else if (side === 'ask' && bestAskPrice) {
      handlePriceChange(bestAskPrice);
    }
  };
  
  // Validate order before submission
  const validateOrder = (): boolean => {
    // Check if quantity is valid
    if (!quantity || quantity <= 0) {
      toast.error('Please enter a valid quantity');
      return false;
    }
    
    // Check minimum order size
    if (quantity < minOrderSize) {
      toast.error(`Quantity must be at least ${minOrderSize}`);
      return false;
    }
    
    // Check maximum order size
    if (quantity > maxOrderSize) {
      toast.error(`Quantity must be at most ${maxOrderSize}`);
      return false;
    }
    
    // Check if price is valid for limit orders
    if (orderType === 'limit' && (!price || price <= 0)) {
      toast.error('Please enter a valid price for limit order');
      return false;
    }
    
    // Check if stop price is valid for stop orders
    if ((orderType === 'stop' || orderType === 'stopLimit') && (!stopPrice || stopPrice <= 0)) {
      toast.error('Please enter a valid stop price');
      return false;
    }
    
    // Check if limit price is valid for stop limit orders
    if (orderType === 'stopLimit' && (!price || price <= 0)) {
      toast.error('Please enter a valid limit price for stop limit order');
      return false;
    }
    
    // Check sufficient balance
    if (activeTab === 'buy') {
      const requiredBalance = orderType === 'market' 
        ? quantity * (bestAskPrice || 0) * 1.05 // Add 5% buffer for market orders
        : quantity * (price || 0);
        
      if (requiredBalance > quoteBalance) {
        toast.error(`Insufficient ${quoteAsset} balance`);
        return false;
      }
    } else if (activeTab === 'sell') {
      if (quantity > baseBalance) {
        toast.error(`Insufficient ${baseAsset} balance`);
        return false;
      }
    }
    
    return true;
  };
  
  // Submit order
  const submitOrderHandler = useCallback(async () => {
    if (!validateOrder()) {
      return;
    }
    
    const orderData = {
      symbol,
      venue,
      side: activeTab,
      type: orderType,
      quantity: quantity || 0,
      price: price,
      stopPrice: stopPrice,
      timeInForce: timeInForce,
      postOnly,
      reduceOnly
    };
    
    if (onOrderSubmit) {
      onOrderSubmit(orderData);
    }
    
    try {
      const result = await submitOrder(orderData);
      
      toast.success(`${activeTab === 'buy' ? 'Buy' : 'Sell'} order submitted successfully`);
      
      // Reset form after successful submission
      if (orderType !== 'market') {
        setQuantity(null);
        setNotional(null);
      }
      
      if (onOrderSuccess) {
        onOrderSuccess(result);
      }
    } catch (error) {
      toast.error(`Order submission failed: ${error.message}`);
      
      if (onOrderError) {
        onOrderError(error);
      }
    }
  }, [
    activeTab, 
    orderType, 
    price, 
    stopPrice, 
    quantity, 
    timeInForce, 
    postOnly, 
    reduceOnly, 
    symbol, 
    venue, 
    submitOrder, 
    onOrderSubmit, 
    onOrderSuccess, 
    onOrderError,
    validateOrder,
    baseAsset,
    quoteAsset,
    baseBalance,
    quoteBalance,
    bestAskPrice
  ]);
  
  // Handle order submission with confirmation if required
  const handleSubmitOrder = () => {
    if (requireConfirmation) {
      const orderDesc = `${activeTab === 'buy' ? 'Buy' : 'Sell'} ${quantity} ${baseAsset} at ${
        orderType === 'market' ? 'market price' : `${formatPrice(price || 0)} ${quoteAsset}`
      }`;
      
      showConfirm({
        title: 'Confirm Order',
        message: `Are you sure you want to ${orderDesc}?`,
        confirmText: activeTab === 'buy' ? 'Buy' : 'Sell',
        confirmVariant: activeTab === 'buy' ? 'success' : 'danger',
        onConfirm: submitOrderHandler
      });
    } else {
      submitOrderHandler();
    }
  };
  
  // Handle one-click trading
  const handleOneClickTrading = (side: 'buy' | 'sell', priceToUse: number) => {
    if (!isOneClickEnabled) return;
    
    // For one-click trading, we always use a limit order at the specified price
    const oneClickOrderData = {
      symbol,
      venue,
      side,
      type: 'limit',
      quantity: side === 'buy' ? 
        adjustToLotSize((quoteBalance * 0.05) / priceToUse) : // Use 5% of available balance
        adjustToLotSize(baseBalance * 0.05), // Use 5% of available balance
      price: adjustToTickSize(priceToUse),
      timeInForce: 'ioc', // Immediate-or-cancel for one-click trading
      postOnly: false,
      reduceOnly: false
    };
    
    if (requireConfirmation) {
      showConfirm({
        title: 'Confirm One-Click Order',
        message: `Are you sure you want to ${side} ${formatQuantity(oneClickOrderData.quantity)} ${baseAsset} at ${formatPrice(oneClickOrderData.price)} ${quoteAsset}?`,
        confirmText: side === 'buy' ? 'Buy' : 'Sell',
        confirmVariant: side === 'buy' ? 'success' : 'danger',
        onConfirm: async () => {
          try {
            await submitOrder(oneClickOrderData);
            toast.success(`One-click ${side} order executed successfully`);
          } catch (error) {
            toast.error(`One-click order failed: ${error.message}`);
          }
        }
      });
    } else {
      submitOrder(oneClickOrderData)
        .then(() => toast.success(`One-click ${side} order executed successfully`))
        .catch(error => toast.error(`One-click order failed: ${error.message}`));
    }
  };
  
  return (
    <Card className="advanced-order-form">
      <Tabs>
        <Tab 
          label="Buy" 
          active={activeTab === 'buy'} 
          onClick={() => setActiveTab('buy')}
          className="buy-tab"
        />
        <Tab 
          label="Sell" 
          active={activeTab === 'sell'} 
          onClick={() => setActiveTab('sell')}
          className="sell-tab"
        />
      </Tabs>
      
      <div className="order-form-content">
        <div className="form-row">
          <label>Order Type</label>
          <Dropdown
            value={orderType}
            onChange={setOrderType}
            options={[
              { value: 'limit', label: 'Limit' },
              { value: 'market', label: 'Market' },
              { value: 'stop', label: 'Stop Market' },
              { value: 'stopLimit', label: 'Stop Limit' }
            ]}
          />
        </div>
        
        {(orderType === 'limit' || orderType === 'stopLimit') && (
          <div className="form-row">
            <label>Price ({quoteAsset})</label>
            <div className="input-with-buttons">
              <NumericInput
                value={price}
                onChange={handlePriceChange}
                step={tickSize}
                precision={Math.ceil(Math.abs(Math.log10(tickSize)))}
                placeholder={`Enter price in ${quoteAsset}`}
              />
              <Button
                size="small"
                variant="secondary"
                onClick={() => useBestPrice('bid')}
                title="Use best bid price"
              >
                Bid
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => useBestPrice('ask')}
                title="Use best ask price"
              >
                Ask
              </Button>
            </div>
          </div>
        )}
        
        {(orderType === 'stop' || orderType === 'stopLimit') && (
          <div className="form-row">
            <label>Stop Price ({quoteAsset})</label>
            <NumericInput
              value={stopPrice}
              onChange={handleStopPriceChange}
              step={tickSize}
              precision={Math.ceil(Math.abs(Math.log10(tickSize)))}
              placeholder={`Enter stop price in ${quoteAsset}`}
            />
          </div>
        )}
        
        <div className="form-row">
          <label>Quantity ({baseAsset})</label>
          <NumericInput
            value={quantity}
            onChange={handleQuantityChange}
            step={lotSize}
            precision={Math.ceil(Math.abs(Math.log10(lotSize)))}
            placeholder={`Enter quantity in ${baseAsset}`}
          />
        </div>
        
        <div className="form-row">
          <label>Total ({quoteAsset})</label>
          <NumericInput
            value={notional}
            onChange={handleNotionalChange}
            step={tickSize}
            precision={Math.ceil(Math.abs(Math.log10(tickSize)))}
            placeholder={`Enter total in ${quoteAsset}`}
            disabled={orderType === 'market'}
          />
        </div>
        
        <div className="form-row percentage-buttons">
          <Button size="small" variant="tertiary" onClick={() => handlePercentageClick(0.25)}>25%</Button>
          <Button size="small" variant="tertiary" onClick={() => handlePercentageClick(0.5)}>50%</Button>
          <Button size="small" variant="tertiary" onClick={() => handlePercentageClick(0.75)}>75%</Button>
          <Button size="small" variant="tertiary" onClick={() => handlePercentageClick(1)}>100%</Button>
        </div>
        
        {orderType !== 'market' && (
          <div className="form-row">
            <label>Time In Force</label>
            <Dropdown
              value={timeInForce}
              onChange={setTimeInForce}
              options={[
                { value: 'gtc', label: 'Good Till Canceled' },
                { value: 'ioc', label: 'Immediate or Cancel' },
                { value: 'fok', label: 'Fill or Kill' }
              ]}
            />
          </div>
        )}
        
        <div className="form-row">
          <div className="switch-container">
            <Switch
              checked={postOnly}
              onChange={setPostOnly}
              disabled={orderType === 'market' || timeInForce !== 'gtc'}
              label="Post Only"
            />
            <Icon 
              name="info-circle" 
              size="small" 
              title="Post Only orders will only be accepted if they would not immediately match and execute." 
            />
          </div>
        </div>
        
        <div className="form-row">
          <div className="switch-container">
            <Switch
              checked={reduceOnly}
              onChange={setReduceOnly}
              label="Reduce Only"
            />
            <Icon 
              name="info-circle" 
              size="small" 
              title="Reduce Only orders will only reduce an existing position, not open a new one." 
            />
          </div>
        </div>
        
        {showOneClickTrading && (
          <div className="form-row">
            <div className="switch-container">
              <Switch
                checked={isOneClickEnabled}
                onChange={setIsOneClickEnabled}
                label="One-Click Trading"
              />
              <Icon 
                name="info-circle" 
                size="small" 
                title="Enable one-click trading by clicking directly on the order book." 
              />
            </div>
          </div>
        )}
        
        <div className="balance-info">
          <div className="balance-row">
            <span>Available {baseAsset}:</span>
            <span>{isLoadingBalances ? '...' : formatQuantity(baseBalance)}</span>
          </div>
          <div className="balance-row">
            <span>Available {quoteAsset}:</span>
            <span>{isLoadingBalances ? '...' : formatQuantity(quoteBalance)}</span>
          </div>
        </div>
        
        <Button
          variant={activeTab === 'buy' ? 'success' : 'danger'}
          size="large"
          fullWidth
          onClick={handleSubmitOrder}
          disabled={isSubmitting}
          loading={isSubmitting}
        >
          {activeTab === 'buy' ? 'Buy' : 'Sell'} {baseAsset}
        </Button>
      </div>
      
      {showOneClickTrading && isOneClickEnabled && (
        <div className="one-click-info">
          <Icon name="exclamation-triangle" color="warning" />
          <span>One-click trading is enabled. Click directly on the order book to execute trades instantly.</span>
        </div>
      )}
    </Card>
  );
};