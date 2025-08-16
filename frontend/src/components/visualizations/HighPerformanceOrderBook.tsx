import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { formatPrice, formatQuantity } from '../../utils/formatters';
import { useResizeObserver } from '../../hooks/useResizeObserver';
import { Spinner } from '../common/Spinner';

interface OrderLevel {
  price: number;
  quantity: number;
  total: number;
  count: number;
}

interface OrderBookData {
  bids: OrderLevel[];
  asks: OrderLevel[];
  timestamp: number;
  spread: number;
  midPrice: number;
  venue: string;
  symbol: string;
}

interface HighPerformanceOrderBookProps {
  data: OrderBookData | null;
  depth?: number;
  grouping?: number;
  highlightRows?: boolean;
  showRowHighlight?: boolean;
  showSpreadLine?: boolean;
  showMarketSizeIndicator?: boolean;
  onPriceClick?: (price: number, side: 'bid' | 'ask') => void;
  isLoading?: boolean;
  error?: string | null;
  width?: number;
  height?: number;
  maxLevel?: number;
}

export const HighPerformanceOrderBook: React.FC<HighPerformanceOrderBookProps> = ({
  data,
  depth = 15,
  grouping = 0,
  highlightRows = true,
  showRowHighlight = true,
  showSpreadLine = true,
  showMarketSizeIndicator = true,
  onPriceClick,
  isLoading = false,
  error = null,
  width = 480,
  height = 600,
  maxLevel = 10000
}) => {
  const { colors, isDarkMode } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width: containerWidth } = useResizeObserver(containerRef);
  const [hoveredRow, setHoveredRow] = useState<{ side: 'bid' | 'ask', index: number } | null>(null);
  const [selectedGrouping, setSelectedGrouping] = useState<number>(grouping);
  const [dimensions, setDimensions] = useState({ width, height });
  
  // Group the order book data based on the selected grouping
  const groupedData = useMemo(() => {
    if (!data) return null;
    
    // If no grouping, return original data
    if (!selectedGrouping) return data;
    
    // Apply grouping to bids and asks
    const groupedBids: OrderLevel[] = [];
    const groupedAsks: OrderLevel[] = [];
    
    // Group bids
    data.bids.forEach(level => {
      const groupPrice = Math.floor(level.price / selectedGrouping) * selectedGrouping;
      const existingLevel = groupedBids.find(l => l.price === groupPrice);
      
      if (existingLevel) {
        existingLevel.quantity += level.quantity;
        existingLevel.count += level.count;
      } else {
        groupedBids.push({
          price: groupPrice,
          quantity: level.quantity,
          total: 0, // Will be calculated later
          count: level.count
        });
      }
    });
    
    // Group asks
    data.asks.forEach(level => {
      const groupPrice = Math.ceil(level.price / selectedGrouping) * selectedGrouping;
      const existingLevel = groupedAsks.find(l => l.price === groupPrice);
      
      if (existingLevel) {
        existingLevel.quantity += level.quantity;
        existingLevel.count += level.count;
      } else {
        groupedAsks.push({
          price: groupPrice,
          quantity: level.quantity,
          total: 0, // Will be calculated later
          count: level.count
        });
      }
    });
    
    // Calculate totals
    let bidTotal = 0;
    groupedBids.forEach(level => {
      bidTotal += level.quantity;
      level.total = bidTotal;
    });
    
    let askTotal = 0;
    groupedAsks.forEach(level => {
      askTotal += level.quantity;
      level.total = askTotal;
    });
    
    // Sort bids descending, asks ascending
    groupedBids.sort((a, b) => b.price - a.price);
    groupedAsks.sort((a, b) => a.price - b.price);
    
    return {
      ...data,
      bids: groupedBids.slice(0, depth),
      asks: groupedAsks.slice(0, depth)
    };
  }, [data, selectedGrouping, depth]);
  
  // Calculate maximum quantities for visualization
  const maxValues = useMemo(() => {
    if (!groupedData) return { maxQuantity: 1, maxTotal: 1 };
    
    const maxBidQuantity = Math.max(...groupedData.bids.map(level => level.quantity), 1);
    const maxAskQuantity = Math.max(...groupedData.asks.map(level => level.quantity), 1);
    const maxQuantity = Math.max(maxBidQuantity, maxAskQuantity);
    
    const maxBidTotal = Math.max(...groupedData.bids.map(level => level.total), 1);
    const maxAskTotal = Math.max(...groupedData.asks.map(level => level.total), 1);
    const maxTotal = Math.max(maxBidTotal, maxAskTotal);
    
    return { maxQuantity, maxTotal };
  }, [groupedData]);
  
  // Update dimensions when container size changes
  useEffect(() => {
    if (containerWidth) {
      setDimensions({
        width: containerWidth,
        height
      });
    }
  }, [containerWidth, height]);
  
  // Render the order book
  const renderOrderBook = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !groupedData) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Set canvas dimensions with device pixel ratio for high DPI screens
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    canvas.style.width = `${dimensions.width}px`;
    canvas.style.height = `${dimensions.height}px`;
    ctx.scale(dpr, dpr);
    
    // Clear canvas
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    
    // Draw background
    ctx.fillStyle = colors.chartBackground;
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
    
    // Calculate row height and column widths
    const headerHeight = 30;
    const rowHeight = 20;
    const totalRows = groupedData.bids.length + groupedData.asks.length;
    const spreadRowHeight = 20;
    
    const columnWidth = dimensions.width / 4;
    
    // Draw header
    ctx.fillStyle = colors.headerBackground;
    ctx.fillRect(0, 0, dimensions.width, headerHeight);
    
    ctx.font = '12px Arial';
    ctx.fillStyle = colors.textPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const headerY = headerHeight / 2;
    
    ctx.fillText('PRICE', columnWidth * 0.5, headerY);
    ctx.fillText('SIZE', columnWidth * 1.5, headerY);
    ctx.fillText('TOTAL', columnWidth * 2.5, headerY);
    ctx.fillText('COUNT', columnWidth * 3.5, headerY);
    
    // Draw bid rows
    const bidStart = headerHeight;
    
    groupedData.bids.forEach((level, index) => {
      const y = bidStart + index * rowHeight;
      
      // Row background
      ctx.fillStyle = index % 2 === 0 ? colors.rowEvenBackground : colors.rowOddBackground;
      
      // Highlight hovered row
      if (hoveredRow && hoveredRow.side === 'bid' && hoveredRow.index === index) {
        ctx.fillStyle = colors.rowHoverBackground;
      }
      
      ctx.fillRect(0, y, dimensions.width, rowHeight);
      
      // Draw quantity visualization
      if (showMarketSizeIndicator) {
        const quantityWidth = (level.quantity / maxValues.maxQuantity) * dimensions.width;
        ctx.fillStyle = colors.bidColor;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(0, y, quantityWidth, rowHeight);
        ctx.globalAlpha = 1.0;
      }
      
      // Text
      ctx.fillStyle = colors.bidTextColor;
      ctx.textAlign = 'right';
      
      // Price
      ctx.fillText(formatPrice(level.price), columnWidth - 5, y + rowHeight / 2);
      
      // Size
      ctx.fillText(formatQuantity(level.quantity), columnWidth * 2 - 5, y + rowHeight / 2);
      
      // Total
      ctx.fillText(formatQuantity(level.total), columnWidth * 3 - 5, y + rowHeight / 2);
      
      // Count
      ctx.fillText(level.count.toString(), columnWidth * 4 - 5, y + rowHeight / 2);
    });
    
    // Draw spread row
    if (showSpreadLine) {
      const spreadY = bidStart + groupedData.bids.length * rowHeight;
      
      ctx.fillStyle = colors.spreadBackground;
      ctx.fillRect(0, spreadY, dimensions.width, spreadRowHeight);
      
      ctx.fillStyle = colors.textPrimary;
      ctx.textAlign = 'center';
      
      const spreadValue = formatPrice(groupedData.spread);
      const spreadPercentage = ((groupedData.spread / groupedData.midPrice) * 100).toFixed(3) + '%';
      ctx.fillText(`Spread: ${spreadValue} (${spreadPercentage})`, dimensions.width / 2, spreadY + spreadRowHeight / 2);
    }
    
    // Draw ask rows
    const askStart = bidStart + groupedData.bids.length * rowHeight + (showSpreadLine ? spreadRowHeight : 0);
    
    groupedData.asks.forEach((level, index) => {
      const y = askStart + index * rowHeight;
      
      // Row background
      ctx.fillStyle = index % 2 === 0 ? colors.rowEvenBackground : colors.rowOddBackground;
      
      // Highlight hovered row
      if (hoveredRow && hoveredRow.side === 'ask' && hoveredRow.index === index) {
        ctx.fillStyle = colors.rowHoverBackground;
      }
      
      ctx.fillRect(0, y, dimensions.width, rowHeight);
      
      // Draw quantity visualization
      if (showMarketSizeIndicator) {
        const quantityWidth = (level.quantity / maxValues.maxQuantity) * dimensions.width;
        ctx.fillStyle = colors.askColor;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(dimensions.width - quantityWidth, y, quantityWidth, rowHeight);
        ctx.globalAlpha = 1.0;
      }
      
      // Text
      ctx.fillStyle = colors.askTextColor;
      ctx.textAlign = 'right';
      
      // Price
      ctx.fillText(formatPrice(level.price), columnWidth - 5, y + rowHeight / 2);
      
      // Size
      ctx.fillText(formatQuantity(level.quantity), columnWidth * 2 - 5, y + rowHeight / 2);
      
      // Total
      ctx.fillText(formatQuantity(level.total), columnWidth * 3 - 5, y + rowHeight / 2);
      
      // Count
      ctx.fillText(level.count.toString(), columnWidth * 4 - 5, y + rowHeight / 2);
    });
    
  }, [groupedData, dimensions, colors, hoveredRow, maxValues.maxQuantity, maxValues.maxTotal, showMarketSizeIndicator, showSpreadLine]);
  
  // Initialize canvas and handle mouse events
  useEffect(() => {
    if (!canvasRef.current) return;
    
    renderOrderBook();
    
    // Mouse move handler for row highlighting
    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef.current || !groupedData) return;
      
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Calculate row index
      const headerHeight = 30;
      const rowHeight = 20;
      const spreadRowHeight = 20;
      
      // Check if mouse is in the bids section
      const bidStart = headerHeight;
      const bidEnd = bidStart + groupedData.bids.length * rowHeight;
      
      if (y >= bidStart && y < bidEnd) {
        const index = Math.floor((y - bidStart) / rowHeight);
        setHoveredRow({ side: 'bid', index });
        return;
      }
      
      // Check if mouse is in the asks section
      const askStart = bidEnd + (showSpreadLine ? spreadRowHeight : 0);
      const askEnd = askStart + groupedData.asks.length * rowHeight;
      
      if (y >= askStart && y < askEnd) {
        const index = Math.floor((y - askStart) / rowHeight);
        setHoveredRow({ side: 'ask', index });
        return;
      }
      
      setHoveredRow(null);
    };
    
    // Click handler for price selection
    const handleClick = (e: MouseEvent) => {
      if (!canvasRef.current || !groupedData || !onPriceClick || !hoveredRow) return;
      
      const side = hoveredRow.side;
      const level = side === 'bid' 
        ? groupedData.bids[hoveredRow.index] 
        : groupedData.asks[hoveredRow.index];
      
      if (level) {
        onPriceClick(level.price, side);
      }
    };
    
    const canvas = canvasRef.current;
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('click', handleClick);
    
    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('click', handleClick);
    };
  }, [groupedData, renderOrderBook, onPriceClick, hoveredRow, showSpreadLine]);
  
  // Re-render when data or hover state changes
  useEffect(() => {
    renderOrderBook();
  }, [renderOrderBook]);
  
  // Handle grouping changes
  const handleGroupingChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseFloat(e.target.value);
    setSelectedGrouping(value);
  };
  
  // Calculate available grouping options based on price range
  const groupingOptions = useMemo(() => {
    if (!data) return [0, 0.01, 0.1, 1, 10, 100];
    
    // Find the smallest ask price and largest bid price
    const minAsk = Math.min(...data.asks.map(level => level.price));
    const maxBid = Math.max(...data.bids.map(level => level.price));
    
    // Calculate reasonable grouping increments
    const priceDifference = minAsk - maxBid;
    const magnitude = Math.floor(Math.log10(priceDifference));
    
    const options = [0]; // 0 means no grouping
    
    // Add small groupings
    options.push(Math.pow(10, magnitude - 1));
    options.push(Math.pow(10, magnitude) * 0.5);
    
    // Add medium groupings
    options.push(Math.pow(10, magnitude));
    options.push(Math.pow(10, magnitude) * 5);
    
    // Add large groupings
    options.push(Math.pow(10, magnitude + 1));
    
    return options.filter(o => o >= 0);
  }, [data]);
  
  return (
    <div 
      ref={containerRef} 
      className="high-performance-order-book" 
      style={{ width: '100%', height: `${height}px` }}
    >
      {isLoading && (
        <div className="loading-overlay">
          <Spinner size="large" />
          <p>Loading order book...</p>
        </div>
      )}
      
      {error && (
        <div className="error-overlay">
          <p>Error loading order book: {error}</p>
        </div>
      )}
      
      <div className="order-book-controls">
        <label>
          Grouping:
          <select value={selectedGrouping} onChange={handleGroupingChange}>
            {groupingOptions.map(option => (
              <option key={option} value={option}>
                {option === 0 ? 'None' : formatPrice(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      
      <canvas 
        ref={canvasRef} 
        style={{ 
          width: `${dimensions.width}px`, 
          height: `${dimensions.height}px`,
          cursor: 'pointer'
        }}
      />
      
      {groupedData && (
        <div className="order-book-info">
          <div className="info-row">
            <span className="info-label">Symbol:</span>
            <span className="info-value">{groupedData.symbol}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Venue:</span>
            <span className="info-value">{groupedData.venue}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Mid Price:</span>
            <span className="info-value">{formatPrice(groupedData.midPrice)}</span>
          </div>
        </div>
      )}
    </div>
  );
};