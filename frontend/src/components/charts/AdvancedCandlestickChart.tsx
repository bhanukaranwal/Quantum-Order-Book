        });
        
        chart.priceScale('volume').applyOptions({
          scaleMargins: {
            top: 0.8,
            bottom: 0,
          },
          borderVisible: false,
        });
      }
      
      // Set references
      chartRef.current = chart;
      candlestickSeriesRef.current = candlestickSeries;
      volumeSeriesRef.current = volumeSeries;
      
      // Set initial data
      candlestickSeries.setData(formattedCandles);
      if (volumeSeries) {
        volumeSeries.setData(volumeData);
      }
      
      // Handle crosshair move
      chart.subscribeCrosshairMove((param) => {
        if (onCrosshairMove) {
          onCrosshairMove(param);
        }
      });
      
      // Fit content
      chart.timeScale().fitContent();
      
      return () => {
        // Cleanup
        if (chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
          candlestickSeriesRef.current = null;
          volumeSeriesRef.current = null;
          indicatorSeriesRefs.current.clear();
        }
      };
    }
  }, []);
  
  // Update chart theme when it changes
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.applyOptions({
        layout: {
          background: { color: colors.chartBackground },
          textColor: colors.textPrimary,
        },
        grid: {
          vertLines: { color: colors.gridLines },
          horzLines: { color: colors.gridLines },
        },
        crosshair: {
          vertLine: { color: colors.crosshair },
          horzLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
        },
        watermark: {
          color: colors.watermark,
        },
      });
      
      if (candlestickSeriesRef.current) {
        candlestickSeriesRef.current.applyOptions({
          upColor: colors.candleUp,
          downColor: colors.candleDown,
          wickUpColor: colors.candleUp,
          wickDownColor: colors.candleDown,
        });
      }
    }
  }, [isDarkMode, colors]);
  
  // Update candle data when it changes
  useEffect(() => {
    if (candlestickSeriesRef.current) {
      candlestickSeriesRef.current.setData(formattedCandles);
    }
  }, [formattedCandles]);
  
  // Update volume data when it changes
  useEffect(() => {
    if (volumeSeriesRef.current && showVolume) {
      volumeSeriesRef.current.setData(volumeData);
    }
  }, [volumeData, showVolume]);
  
  // Handle indicators
  useEffect(() => {
    // Remove old indicators
    indicatorSeriesRefs.current.forEach((series, id) => {
      if (chartRef.current) {
        chartRef.current.removeSeries(series);
      }
    });
    indicatorSeriesRefs.current.clear();
    
    // Add new indicators
    if (chartRef.current) {
      selectedIndicators.forEach((indicator) => {
        const data = indicatorData.get(indicator.id);
        if (data) {
          const series = chartRef.current!.addLineSeries({
            color: indicator.color || colors.indicatorDefault,
            lineWidth: 2,
            priceScaleId: indicator.overlay ? 'right' : `${indicator.id}`,
            priceFormat: {
              type: 'price',
              precision: indicator.precision || 2,
            },
            scaleMargins: indicator.overlay 
              ? undefined 
              : {
                top: 0.1,
                bottom: 0.3,
              },
            title: indicator.name,
          });
          
          series.setData(data);
          indicatorSeriesRefs.current.set(indicator.id, series);
        }
      });
      
      // Fit content after adding indicators
      chartRef.current.timeScale().fitContent();
    }
  }, [selectedIndicators, indicatorData, colors]);
  
  // Handle event markers
  useEffect(() => {
    // Clear existing markers
    eventMarkersRef.current.forEach(marker => {
      if (marker.remove) marker.remove();
    });
    eventMarkersRef.current = [];
    
    // Add new markers
    if (chartRef.current && candlestickSeriesRef.current && events.length > 0) {
      const markers = events.map(event => {
        return new EventMarker(
          chartRef.current!,
          candlestickSeriesRef.current!,
          event
        );
      });
      
      eventMarkersRef.current = markers;
    }
  }, [events]);
  
  // Handle indicators selection
  const handleIndicatorToggle = (indicator: TechnicalIndicator) => {
    setSelectedIndicators(prev => {
      const exists = prev.some(i => i.id === indicator.id);
      if (exists) {
        return prev.filter(i => i.id !== indicator.id);
      } else {
        return [...prev, indicator];
      }
    });
  };
  
  // Handle timeframe change
  const handleTimeframeChange = (newTimeframe: string) => {
    if (onTimeframeChange) {
      onTimeframeChange(newTimeframe);
    }
  };
  
  return (
    <div className="advanced-candlestick-chart">
      {showToolbar && (
        <div className="chart-toolbar">
          <TimeframeSelector 
            currentTimeframe={timeframe}
            onChange={handleTimeframeChange}
          />
          
          {allowIndicators && (
            <IndicatorSelector
              selectedIndicators={selectedIndicators}
              onToggle={handleIndicatorToggle}
            />
          )}
          
          <ChartControls 
            onReset={() => chartRef.current?.timeScale().fitContent()}
            allowZoom={allowZoom}
          />
        </div>
      )}
      
      <div 
        ref={chartContainerRef} 
        className="chart-container" 
        style={{ height: `${height}px` }}
      >
        {isLoading && (
          <div className="chart-loading-overlay">
            <div className="spinner"></div>
            <div>Loading chart data...</div>
          </div>
        )}
        
        {error && (
          <div className="chart-error-overlay">
            <div className="error-icon">!</div>
            <div>{error}</div>
          </div>
        )}
        
        {allowAnnotations && chartRef.current && (
          <ChartAnnotations 
            chart={chartRef.current} 
            candlestickSeries={candlestickSeriesRef.current!}
          />
        )}
        
        {showToolbar && chartRef.current && (
          <ToolbarOverlay 
            chart={chartRef.current}
            isDarkMode={isDarkMode}
          />
        )}
      </div>
    </div>
  );
};