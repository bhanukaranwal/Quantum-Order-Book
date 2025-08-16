import React, { useState, useEffect, useMemo } from 'react';
import { formatPrice, formatQuantity } from '../utils/formatters';

interface Order {
  id: string;
  price: number;
  quantity: number;
  timestamp: number;
  venue: string;
  participantType?: string;
}

interface OrderBookSide {
  orders: Order[];
  total: number;
}

interface OrderBookProps {
  data: {
    bids: OrderBookSide;
    asks: OrderBookSide;
    spread: number;
    timestamp: number;
  } | null;
  isLoading: boolean;
  error?: Error | null;
  levels?: number;
}

export const OrderBook: React.FC<OrderBookProps> = ({ 
  data, 
  isLoading, 
  error,
  levels = 10
}) => {
  const [grouping, setGrouping] = useState<number>(0.01);
  
  const groupedData = useMemo(() => {
    if (!data) return { bids: { orders: [], total: 0 }, asks: { orders: [], total: 0 }, spread: 0, timestamp: 0 };
    
    // Group orders by price level according to grouping
    // This would be a more complex implementation in production
    return data;
  }, [data, grouping]);
  
  if (isLoading) return <div className="order-book-loading">Loading order book data...</div>;
  if (error) return <div className="order-book-error">Error: {error.message}</div>;
  if (!data) return <div className="order-book-empty">No order book data available</div>;
  
  return (
    <div className="order-book">
      <div className="order-book-header">
        <h2>Order Book</h2>
        <div className="order-book-controls">
          <label>
            Group:
            <select 
              value={grouping} 
              onChange={(e) => setGrouping(parseFloat(e.target.value))}
            >
              <option value="0.01">0.01</option>
              <option value="0.1">0.1</option>
              <option value="1">1.0</option>
            </select>
          </label>
        </div>
      </div>
      
      <div className="order-book-spread">
        Spread: {formatPrice(data.spread)} ({((data.spread / data.asks.orders[0]?.price) * 100).toFixed(3)}%)
      </div>
      
      <div className="order-book-content">
        <div className="order-book-side bids">
          <div className="order-book-header-row">
            <div>Price</div>
            <div>Size</div>
            <div>Total</div>
            <div>Count</div>
          </div>
          
          {groupedData.bids.orders.slice(0, levels).map((level, i) => (
            <div 
              key={`bid-${i}`} 
              className="order-book-row bid"
              style={{
                background: `linear-gradient(to left, rgba(0, 128, 0, 0.1) ${(level.quantity / groupedData.bids.total) * 100}%, transparent 0%)`
              }}
            >
              <div className="price">{formatPrice(level.price)}</div>
              <div className="size">{formatQuantity(level.quantity)}</div>
              <div className="total">{formatQuantity(level.quantity)}</div>
              <div className="count">1</div>
            </div>
          ))}
        </div>
        
        <div className="order-book-side asks">
          <div className="order-book-header-row">
            <div>Count</div>
            <div>Total</div>
            <div>Size</div>
            <div>Price</div>
          </div>
          
          {groupedData.asks.orders.slice(0, levels).map((level, i) => (
            <div 
              key={`ask-${i}`} 
              className="order-book-row ask"
              style={{
                background: `linear-gradient(to right, rgba(128, 0, 0, 0.1) ${(level.quantity / groupedData.asks.total) * 100}%, transparent 0%)`
              }}
            >
              <div className="count">1</div>
              <div className="total">{formatQuantity(level.quantity)}</div>
              <div className="size">{formatQuantity(level.quantity)}</div>
              <div className="price">{formatPrice(level.price)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};