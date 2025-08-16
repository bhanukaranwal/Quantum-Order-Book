import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { useTheme } from '../../hooks/useTheme';
import { useResizeObserver } from '../../hooks/useResizeObserver';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { formatPrice, formatQuantity } from '../../utils/formatters';

interface OrderLevel {
  price: number;
  quantity: number;
  total: number;
}

interface MarketDepthData {
  bids: OrderLevel[];
  asks: OrderLevel[];
  midPrice: number;
  spreadPercentage: number;
  bidTotal: number;
  askTotal: number;
  timestamp: number;
  venue: string;
  symbol: string;
}

interface MarketDepthChartProps {
  data: MarketDepthData | null;
  width?: number;
  height?: number;
  maxDepthPercentage?: number;
  isLoading?: boolean;
  error?: string | null;
  onPriceClick?: (price: number, side: 'bid' | 'ask') => void;
  showSpread?: boolean;
  showImbalance?: boolean;
  showCumulative?: boolean;
  showTooltip?: boolean;
  animated?: boolean;
}

export const MarketDepthChart: React.FC<MarketDepthChartProps> = ({
  data,
  width = 800,
  height = 500,
  maxDepthPercentage = 15,
  isLoading = false,
  error = null,
  onPriceClick,
  showSpread = true,
  showImbalance = true,
  showCumulative = true,
  showTooltip = true,
  animated = true
}) => {
  const { colors, isDarkMode } = useTheme();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth } = useResizeObserver(containerRef);
  const [dimensions, setDimensions] = useState({ width, height });
  const [hoveredData, setHoveredData] = useState<{
    side: 'bid' | 'ask';
    price: number;
    quantity: number;
    total: number;
    x: number;
    y: number;
  } | null>(null);
  
  // Update dimensions when container size changes
  useEffect(() => {
    if (containerWidth) {
      setDimensions({
        width: containerWidth,
        height
      });
    }
  }, [containerWidth, height]);
  
  // Calculate min and max prices for scaling
  const priceRange = React.useMemo(() => {
    if (!data) return { min: 0, max: 0, range: 0 };
    
    const minBidPrice = data.bids.length > 0 ? Math.min(...data.bids.map(b => b.price)) : data.midPrice * 0.9;
    const maxAskPrice = data.asks.length > 0 ? Math.max(...data.asks.map(a => a.price)) : data.midPrice * 1.1;
    
    // Calculate range and add padding
    const rawRange = maxAskPrice - minBidPrice;
    const padding = rawRange * (maxDepthPercentage / 100);
    const min = Math.max(0, minBidPrice - padding);
    const max = maxAskPrice + padding;
    
    return {
      min,
      max,
      range: max - min
    };
  }, [data, maxDepthPercentage]);
  
  // Format number as percentage
  const formatPercentage = (value: number): string => {
    return `${(value * 100).toFixed(2)}%`;
  };
  
  // Create the market depth chart
  const renderChart = useCallback(() => {
    if (!data || !svgRef.current) return;
    
    // Select the SVG element
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous content
    
    // Set up dimensions
    const margin = { top: 20, right: 30, bottom: 40, left: 60 };
    const width = dimensions.width - margin.left - margin.right;
    const height = dimensions.height - margin.top - margin.bottom;
    
    // Create scales
    const xScale = d3.scaleLinear()
      .domain([priceRange.min, priceRange.max])
      .range([0, width]);
    
    // Find maximum total for y-scale
    const maxBidTotal = data.bids.length > 0 ? data.bids[data.bids.length - 1].total : 0;
    const maxAskTotal = data.asks.length > 0 ? data.asks[data.asks.length - 1].total : 0;
    const maxTotal = Math.max(maxBidTotal, maxAskTotal);
    
    const yScale = d3.scaleLinear()
      .domain([0, maxTotal])
      .range([height, 0]);
    
    // Create axes
    const xAxis = d3.axisBottom(xScale)
      .tickFormat(d => formatPrice(d as number));
    
    const yAxis = d3.axisLeft(yScale)
      .tickFormat(d => formatQuantity(d as number));
    
    // Create container group
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);
    
    // Add axes
    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);
    
    g.append('g')
      .attr('class', 'y-axis')
      .call(yAxis);
    
    // Add axis labels
    g.append('text')
      .attr('class', 'x-axis-label')
      .attr('text-anchor', 'middle')
      .attr('x', width / 2)
      .attr('y', height + margin.bottom - 5)
      .style('fill', colors.textPrimary)
      .text('Price');
    
    g.append('text')
      .attr('class', 'y-axis-label')
      .attr('text-anchor', 'middle')
      .attr('transform', `translate(${-margin.left + 15},${height / 2}) rotate(-90)`)
      .style('fill', colors.textPrimary)
      .text('Cumulative Size');
    
    // Create area generator for bid side
    const bidAreaGenerator = d3.area<OrderLevel>()
      .x(d => xScale(d.price))
      .y0(height)
      .y1(d => yScale(d.total))
      .curve(d3.curveStepAfter);
    
    // Create area generator for ask side
    const askAreaGenerator = d3.area<OrderLevel>()
      .x(d => xScale(d.price))
      .y0(height)
      .y1(d => yScale(d.total))
      .curve(d3.curveStepBefore);
    
    // Add bid area
    const bidArea = g.append('path')
      .datum(data.bids)
      .attr('class', 'bid-area')
      .attr('d', bidAreaGenerator)
      .attr('fill', colors.bidColor)
      .attr('fill-opacity', 0.7)
      .attr('stroke', colors.bidColor)
      .attr('stroke-width', 1);
    
    // Add ask area
    const askArea = g.append('path')
      .datum(data.asks)
      .attr('class', 'ask-area')
      .attr('d', askAreaGenerator)
      .attr('fill', colors.askColor)
      .attr('fill-opacity', 0.7)
      .attr('stroke', colors.askColor)
      .attr('stroke-width', 1);
    
    // Add animation if enabled
    if (animated) {
      bidArea.style('opacity', 0)
        .transition()
        .duration(750)
        .style('opacity', 0.7);
      
      askArea.style('opacity', 0)
        .transition()
        .duration(750)
        .style('opacity', 0.7);
    }
    
    // Add mid price line
    g.append('line')
      .attr('class', 'mid-price-line')
      .attr('x1', xScale(data.midPrice))
      .attr('y1', 0)
      .attr('x2', xScale(data.midPrice))
      .attr('y2', height)
      .attr('stroke', colors.textSecondary)
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3');
    
    // Add mid price label
    g.append('text')
      .attr('class', 'mid-price-label')
      .attr('x', xScale(data.midPrice))
      .attr('y', -5)
      .attr('text-anchor', 'middle')
      .style('fill', colors.textPrimary)
      .text(`Mid: ${formatPrice(data.midPrice)}`);
    
    // Add spread indicator if enabled
    if (showSpread && data.bids.length > 0 && data.asks.length > 0) {
      const bestBidPrice = data.bids[0].price;
      const bestAskPrice = data.asks[0].price;
      
      g.append('rect')
        .attr('class', 'spread-indicator')
        .attr('x', xScale(bestBidPrice))
        .attr('y', 0)
        .attr('width', xScale(bestAskPrice) - xScale(bestBidPrice))
        .attr('height', height)
        .attr('fill', colors.spreadBackground)
        .attr('fill-opacity', 0.2);
      
      g.append('text')
        .attr('class', 'spread-label')
        .attr('x', xScale((bestBidPrice + bestAskPrice) / 2))
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('fill', colors.textSecondary)
        .text(`Spread: ${formatPercentage(data.spreadPercentage)}`);
    }
    
    // Add order imbalance indicator if enabled
    if (showImbalance && data.bidTotal > 0 && data.askTotal > 0) {
      const imbalance = (data.bidTotal - data.askTotal) / (data.bidTotal + data.askTotal);
      const imbalanceWidth = 80;
      const imbalanceHeight = 24;
      
      // Create group for imbalance indicator
      const imbalanceGroup = g.append('g')
        .attr('class', 'imbalance-indicator')
        .attr('transform', `translate(${width - imbalanceWidth}, ${margin.top})`);
      
      // Background rectangle
      imbalanceGroup.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', imbalanceWidth)
        .attr('height', imbalanceHeight)
        .attr('rx', 4)
        .attr('fill', colors.cardBackground)
        .attr('stroke', colors.border)
        .attr('stroke-width', 1);
      
      // Imbalance bar background
      imbalanceGroup.append('rect')
        .attr('x', 5)
        .attr('y', imbalanceHeight / 2 - 3)
        .attr('width', imbalanceWidth - 10)
        .attr('height', 6)
        .attr('rx', 3)
        .attr('fill', colors.gridLines);
      
      // Calculate imbalance bar position and width
      const imbalanceBarWidth = (imbalanceWidth - 10) / 2 * Math.abs(imbalance);
      const imbalanceBarX = imbalance < 0
        ? (imbalanceWidth / 2) - imbalanceBarWidth
        : imbalanceWidth / 2;
      
      // Imbalance bar
      imbalanceGroup.append('rect')
        .attr('x', imbalanceBarX)
        .attr('y', imbalanceHeight / 2 - 3)
        .attr('width', imbalanceBarWidth)
        .attr('height', 6)
        .attr('rx', 3)
        .attr('fill', imbalance > 0 ? colors.bidColor : colors.askColor);
      
      // Center marker
      imbalanceGroup.append('line')
        .attr('x1', imbalanceWidth / 2)
        .attr('y1', imbalanceHeight / 2 - 5)
        .attr('x2', imbalanceWidth / 2)
        .attr('y2', imbalanceHeight / 2 + 5)
        .attr('stroke', colors.textPrimary)
        .attr('stroke-width', 1);
      
      // Label
      imbalanceGroup.append('text')
        .attr('x', imbalanceWidth / 2)
        .attr('y', imbalanceHeight - 5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '8px')
        .style('fill', colors.textSecondary)
        .text(`Imbalance: ${formatPercentage(imbalance)}`);
    }
    
    // Add interactive elements for tooltips
    if (showTooltip) {
      // Add invisible hover areas for bid side
      data.bids.forEach((bid, i) => {
        const nextPrice = i > 0 ? data.bids[i - 1].price : bid.price - (data.bids[0].price - data.bids[1]?.price || 0);
        
        g.append('rect')
          .attr('class', 'hover-area')
          .attr('x', xScale(nextPrice))
          .attr('y', 0)
          .attr('width', xScale(bid.price) - xScale(nextPrice))
          .attr('height', height)
          .attr('fill', 'transparent')
          .attr('cursor', 'pointer')
          .on('mouseover', (event) => {
            const [x, y] = d3.pointer(event);
            setHoveredData({
              side: 'bid',
              price: bid.price,
              quantity: bid.quantity,
              total: bid.total,
              x: x + margin.left,
              y
            });
          })
          .on('mouseout', () => {
            setHoveredData(null);
          })
          .on('click', () => {
            if (onPriceClick) {
              onPriceClick(bid.price, 'bid');
            }
          });
      });
      
      // Add invisible hover areas for ask side
      data.asks.forEach((ask, i) => {
        const nextPrice = i > 0 ? data.asks[i - 1].price : ask.price + (data.asks[1]?.price - data.asks[0].price || 0);
        
        g.append('rect')
          .attr('class', 'hover-area')
          .attr('x', xScale(ask.price))
          .attr('y', 0)
          .attr('width', xScale(nextPrice) - xScale(ask.price))
          .attr('height', height)
          .attr('fill', 'transparent')
          .attr('cursor', 'pointer')
          .on('mouseover', (event) => {
            const [x, y] = d3.pointer(event);
            setHoveredData({
              side: 'ask',
              price: ask.price,
              quantity: ask.quantity,
              total: ask.total,
              x: x + margin.left,
              y
            });
          })
          .on('mouseout', () => {
            setHoveredData(null);
          })
          .on('click', () => {
            if (onPriceClick) {
              onPriceClick(ask.price, 'ask');
            }
          });
      });
    }
    
  }, [data, dimensions, priceRange, colors, animated, showSpread, showImbalance, showTooltip, onPriceClick]);
  
  // Render chart when data or dimensions change
  useEffect(() => {
    if (data) {
      renderChart();
    }
  }, [data, dimensions, renderChart]);
  
  return (
    <div 
      ref={containerRef}
      className="market-depth-chart"
      style={{ width: '100%', height: `${height}px`, position: 'relative' }}
    >
      {isLoading && (
        <div className="loading-overlay">
          <Spinner size="medium" />
          <p>Loading market depth data...</p>
        </div>
      )}
      
      {error && (
        <div className="error-overlay">
          <p>Error: {error}</p>
        </div>
      )}
      
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="market-depth-svg"
      />
      
      {hoveredData && (
        <div 
          className="tooltip"
          style={{
            position: 'absolute',
            left: `${hoveredData.x + 10}px`,
            top: `${hoveredData.y - 10}px`,
            backgroundColor: colors.tooltipBackground,
            color: colors.textPrimary,
            padding: '8px',
            borderRadius: '4px',
            fontSize: '12px',
            pointerEvents: 'none',
            border: `1px solid ${colors.border}`,
            zIndex: 100
          }}
        >
          <div className="tooltip-header">
            <span className={`side-indicator ${hoveredData.side}`}>
              {hoveredData.side.toUpperCase()}
            </span>
          </div>
          <div className="tooltip-content">
            <div className="tooltip-row">
              <span className="tooltip-label">Price:</span>
              <span className="tooltip-value">{formatPrice(hoveredData.price)}</span>
            </div>
            <div className="tooltip-row">
              <span className="tooltip-label">Quantity:</span>
              <span className="tooltip-value">{formatQuantity(hoveredData.quantity)}</span>
            </div>
            {showCumulative && (
              <div className="tooltip-row">
                <span className="tooltip-label">Total:</span>
                <span className="tooltip-value">{formatQuantity(hoveredData.total)}</span>
              </div>
            )}
          </div>
        </div>
      )}
      
      <div className="chart-controls">
        <Button
          variant="text"
          size="small"
          onClick={() => renderChart()}
          icon="refresh"
          title="Refresh chart"
        />
      </div>
    </div>
  );
};