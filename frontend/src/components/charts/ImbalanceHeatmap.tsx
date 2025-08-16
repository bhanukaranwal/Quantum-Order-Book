import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { useTheme } from '../../hooks/useTheme';
import { useResizeObserver } from '../../hooks/useResizeObserver';
import { Spinner } from '../common/Spinner';
import { formatTime, formatPrice, formatPercentage } from '../../utils/formatters';

interface ImbalanceData {
  symbol: string;
  venue: string;
  timestamp: number;
  imbalance: number; // -1 to 1 where negative is sell pressure, positive is buy pressure
  bidVolume: number;
  askVolume: number;
  spreadBps: number; // Spread in basis points
  lastPrice: number;
  priceChangePercent: number;
}

interface ImbalanceHeatmapProps {
  data: ImbalanceData[];
  isLoading?: boolean;
  error?: string | null;
  height?: number;
  onSymbolClick?: (symbol: string, venue: string) => void;
  sortBy?: 'imbalance' | 'volume' | 'symbol' | 'priceChange';
  sortDirection?: 'asc' | 'desc';
  filterThreshold?: number; // Show only absolute imbalance above this threshold
}

export const ImbalanceHeatmap: React.FC<ImbalanceHeatmapProps> = ({
  data,
  isLoading = false,
  error = null,
  height = 500,
  onSymbolClick,
  sortBy = 'imbalance',
  sortDirection = 'desc',
  filterThreshold = 0
}) => {
  const { colors, isDarkMode } = useTheme();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth } = useResizeObserver(containerRef);
  const [dimensions, setDimensions] = useState({ width: 0, height });
  
  // Sort and filter data
  const processedData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    
    // Filter by threshold if needed
    let filteredData = filterThreshold > 0 
      ? data.filter(d => Math.abs(d.imbalance) >= filterThreshold)
      : [...data];
    
    // Sort data
    filteredData.sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case 'imbalance':
          comparison = Math.abs(b.imbalance) - Math.abs(a.imbalance);
          break;
        case 'volume':
          comparison = (b.bidVolume + b.askVolume) - (a.bidVolume + a.askVolume);
          break;
        case 'symbol':
          comparison = a.symbol.localeCompare(b.symbol);
          break;
        case 'priceChange':
          comparison = Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent);
          break;
      }
      
      return sortDirection === 'asc' ? -comparison : comparison;
    });
    
    return filteredData;
  }, [data, sortBy, sortDirection, filterThreshold]);
  
  // Calculate cell dimensions based on container size and data length
  useEffect(() => {
    if (containerWidth && processedData.length > 0) {
      setDimensions({
        width: containerWidth,
        height
      });
    }
  }, [containerWidth, height, processedData.length]);
  
  // Create D3 visualization
  const renderChart = useCallback(() => {
    if (!svgRef.current || !dimensions.width || !processedData.length) return;
    
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous rendering
    
    const { width, height } = dimensions;
    const margin = { top: 30, right: 30, bottom: 50, left: 150 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    
    // Group data by asset
    const uniqueAssets = Array.from(new Set(processedData.map(d => `${d.symbol} (${d.venue})`)));
    const cellHeight = Math.min(30, innerHeight / uniqueAssets.length);
    const adjustedHeight = cellHeight * uniqueAssets.length + margin.top + margin.bottom;
    
    // Update SVG height based on number of assets
    svg.attr('height', adjustedHeight);
    
    // Create scales
    const xScale = d3.scaleTime()
      .domain([
        d3.min(processedData, d => d.timestamp) || Date.now() - 3600000,
        d3.max(processedData, d => d.timestamp) || Date.now()
      ])
      .range([0, innerWidth]);
    
    const yScale = d3.scaleBand()
      .domain(uniqueAssets)
      .range([0, uniqueAssets.length * cellHeight])
      .padding(0.1);
    
    // Color scale for imbalance
    const imbalanceColorScale = d3.scaleSequential(d3.interpolateRdYlGn)
      .domain([-1, 1]); // Red for sell pressure, green for buy pressure
    
    // Create container group
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${margin.top})`);
    
    // Add x-axis (time)
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat(d => formatTime(d as Date));
    
    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0, ${uniqueAssets.length * cellHeight})`)
      .call(xAxis)
      .selectAll('text')
      .style('text-anchor', 'end')
      .attr('dx', '-.8em')
      .attr('dy', '.15em')
      .attr('transform', 'rotate(-45)');
    
    // Add y-axis (assets)
    const yAxis = d3.axisLeft(yScale);
    
    g.append('g')
      .attr('class', 'y-axis')
      .call(yAxis)
      .selectAll('text')
      .style('font-size', '12px')
      .style('cursor', 'pointer')
      .on('click', function(event, d) {
        if (onSymbolClick) {
          const [symbol, venue] = d.toString().split(' (');
          onSymbolClick(symbol, venue.replace(')', ''));
        }
      });
    
    // Define tooltip
    const tooltip = d3.select(tooltipRef.current)
      .style('position', 'absolute')
      .style('visibility', 'hidden')
      .style('background-color', colors.tooltipBackground)
      .style('color', colors.textPrimary)
      .style('border', `1px solid ${colors.border}`)
      .style('border-radius', '4px')
      .style('padding', '8px')
      .style('font-size', '12px')
      .style('pointer-events', 'none')
      .style('z-index', '10');
    
    // Add heatmap cells
    processedData.forEach(d => {
      const assetKey = `${d.symbol} (${d.venue})`;
      
      g.append('rect')
        .attr('x', xScale(d.timestamp))
        .attr('y', yScale(assetKey) || 0)
        .attr('width', 10)
        .attr('height', yScale.bandwidth())
        .attr('fill', imbalanceColorScale(d.imbalance))
        .attr('stroke', colors.border)
        .attr('stroke-width', 0.5)
        .attr('rx', 2)
        .attr('ry', 2)
        .style('cursor', 'pointer')
        .on('mouseover', function(event) {
          tooltip
            .style('visibility', 'visible')
            .html(`
              <div><strong>${d.symbol} (${d.venue})</strong></div>
              <div>Time: ${formatTime(new Date(d.timestamp))}</div>
              <div>Imbalance: ${formatPercentage(d.imbalance)}</div>
              <div>Bid Volume: ${d.bidVolume.toLocaleString()}</div>
              <div>Ask Volume: ${d.askVolume.toLocaleString()}</div>
              <div>Spread: ${d.spreadBps.toFixed(2)} bps</div>
              <div>Last Price: ${formatPrice(d.lastPrice)}</div>
              <div>Price Change: ${formatPercentage(d.priceChangePercent)}</div>
            `);
          
          const [x, y] = d3.pointer(event);
          tooltip
            .style('left', `${event.pageX + 10}px`)
            .style('top', `${event.pageY - 10}px`);
        })
        .on('mouseout', function() {
          tooltip.style('visibility', 'hidden');
        })
        .on('click', function() {
          if (onSymbolClick) {
            onSymbolClick(d.symbol, d.venue);
          }
        });
    });
    
    // Add legend
    const legendWidth = 200;
    const legendHeight = 20;
    const legendX = innerWidth - legendWidth;
    const legendY = -margin.top + 10;
    
    const defs = svg.append('defs');
    
    // Create gradient for legend
    const gradient = defs.append('linearGradient')
      .attr('id', 'imbalance-gradient')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '0%');
    
    gradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', imbalanceColorScale(-1));
    
    gradient.append('stop')
      .attr('offset', '50%')
      .attr('stop-color', imbalanceColorScale(0));
    
    gradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', imbalanceColorScale(1));
    
    // Add legend rectangle
    g.append('rect')
      .attr('x', legendX)
      .attr('y', legendY)
      .attr('width', legendWidth)
      .attr('height', legendHeight)
      .style('fill', 'url(#imbalance-gradient)');
    
    // Add legend text
    g.append('text')
      .attr('x', legendX)
      .attr('y', legendY - 5)
      .style('font-size', '10px')
      .style('text-anchor', 'start')
      .text('Sell Pressure');
    
    g.append('text')
      .attr('x', legendX + legendWidth)
      .attr('y', legendY - 5)
      .style('font-size', '10px')
      .style('text-anchor', 'end')
      .text('Buy Pressure');
    
    // Add title
    svg.append('text')
      .attr('x', width / 2)
      .attr('y', 15)
      .attr('text-anchor', 'middle')
      .style('font-size', '16px')
      .text('Order Book Imbalance Heatmap');
    
  }, [dimensions, processedData, colors, onSymbolClick]);
  
  // Render chart when data or dimensions change
  useEffect(() => {
    if (processedData.length > 0 && dimensions.width > 0) {
      renderChart();
    }
  }, [processedData, dimensions, renderChart]);
  
  return (
    <div 
      ref={containerRef} 
      className="imbalance-heatmap-container"
      style={{ width: '100%', height: `${height}px`, position: 'relative' }}
    >
      {isLoading && (
        <div className="loading-overlay">
          <Spinner />
          <p>Loading data...</p>
        </div>
      )}
      
      {error && (
        <div className="error-overlay">
          <p>Error loading data: {error}</p>
        </div>
      )}
      
      {!isLoading && !error && processedData.length === 0 && (
        <div className="empty-state">
          <p>No data available. Try adjusting your filters.</p>
        </div>
      )}
      
      <svg 
        ref={svgRef} 
        width="100%" 
        height={height}
        style={{ overflow: 'visible' }}
      />
      
      <div ref={tooltipRef} className="tooltip" />
    </div>
  );
};