        const intersects = raycasterRef.current.intersectObjects(sceneRef.current.children);
        
        if (intersects.length > 0) {
          const object = intersects[0].object;
          if (object.userData && object.userData.orderData) {
            setHoveredOrder(object.userData.orderData);
          } else {
            setHoveredOrder(null);
          }
        } else {
          setHoveredOrder(null);
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    // Cleanup on unmount
    return () => {
      if (frameIdRef.current !== null) {
        cancelAnimationFrame(frameIdRef.current);
      }
      
      renderer.domElement.removeEventListener('mousemove', handleMouseMove);
      
      // Dispose of resources
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          if (object.geometry) object.geometry.dispose();
          
          if (object.material) {
            if (Array.isArray(object.material)) {
              object.material.forEach(material => material.dispose());
            } else {
              object.material.dispose();
            }
          }
        }
      });
    };
  }, [width, height, colors.chartBackground, cameraPosition]);

  // Update camera position when visualization type changes
  useEffect(() => {
    if (!cameraRef.current) return;

    switch (visualizationType) {
      case 'time':
        setCameraPosition({ x: 0, y: 10, z: 20 });
        break;
      case 'price':
        setCameraPosition({ x: 20, y: 10, z: 0 });
        break;
      case '3d':
        setCameraPosition({ x: 15, y: 15, z: 15 });
        break;
    }

    cameraRef.current.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    cameraRef.current.lookAt(0, 0, 0);
  }, [visualizationType, cameraPosition]);

  // Create or update visualization based on data changes
  useEffect(() => {
    if (!sceneRef.current || processedData.length === 0) return;

    // Clear previous visualization
    const scene = sceneRef.current;
    while (scene.children.length > 0) {
      const object = scene.children[0];
      scene.remove(object);
    }

    // Add grid and axes back
    const gridHelper = new THREE.GridHelper(20, 20, 0x555555, 0x333333);
    scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // Add ambient and directional light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 20, 10);
    scene.add(directionalLight);

    // Sort data by timestamp (oldest first)
    const sortedData = [...processedData].sort((a, b) => a.timestamp - b.timestamp);

    // Find min and max timestamps for normalization
    const timestamps = sortedData.map(order => order.timestamp);
    const minTimestamp = Math.min(...timestamps);
    const maxTimestamp = Math.max(...timestamps);
    const timeRange = maxTimestamp - minTimestamp;

    // Create visualization based on type
    if (visualizationType === 'time' || visualizationType === '3d') {
      // Time-based visualization (x-axis: time, y-axis: price)
      sortedData.forEach((order, index) => {
        // Normalize coordinates to visualization space
        const x = ((order.timestamp - minTimestamp) / timeRange) * 20 - 10; // Range: -10 to 10
        const y = ((order.price - priceRange.min) / priceRange.range) * 10; // Range: 0 to 10
        
        // For 3D mode, use z-axis for quantity
        const z = visualizationType === '3d' 
          ? Math.min(Math.log10(order.quantity + 1) * 2, 10) - 5 // Log scale for better visualization
          : 0;
        
        // Create geometry based on order type
        let geometry;
        if (order.type === 'trade') {
          geometry = new THREE.SphereGeometry(0.2, 16, 16);
        } else if (order.type === 'new') {
          geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        } else if (order.type === 'cancel') {
          geometry = new THREE.ConeGeometry(0.15, 0.3, 16);
        } else {
          geometry = new THREE.TorusGeometry(0.1, 0.05, 16, 16);
        }
        
        // Create material based on order side
        let material;
        if (order.side === 'buy') {
          material = new THREE.MeshPhongMaterial({ 
            color: order.isAggressor ? colors.buyAggressorColor : colors.buyColor,
            transparent: true,
            opacity: 0.8
          });
        } else {
          material = new THREE.MeshPhongMaterial({ 
            color: order.isAggressor ? colors.sellAggressorColor : colors.sellColor,
            transparent: true,
            opacity: 0.8
          });
        }
        
        // Create mesh and position it
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        
        // Scale based on quantity (logarithmic scale for better visibility)
        const scale = Math.log10(order.quantity + 1) * 0.5 + 0.5;
        mesh.scale.set(scale, scale, scale);
        
        // Store order data for interaction
        mesh.userData = { orderData: order };
        
        // Add to scene
        scene.add(mesh);
      });
    } else if (visualizationType === 'price') {
      // Price-based visualization (histogram-like, x-axis: price, y-axis: count)
      
      // Group orders by price
      const priceGroups: Record<number, OrderFlowData[]> = {};
      
      sortedData.forEach(order => {
        // Round price to group similar prices
        const roundedPrice = Math.round(order.price * 100) / 100;
        
        if (!priceGroups[roundedPrice]) {
          priceGroups[roundedPrice] = [];
        }
        
        priceGroups[roundedPrice].push(order);
      });
      
      // Create bars for each price level
      Object.entries(priceGroups).forEach(([priceStr, orders]) => {
        const price = parseFloat(priceStr);
        const x = ((price - priceRange.min) / priceRange.range) * 20 - 10; // Range: -10 to 10
        
        // Create separate bars for buys and sells
        const buyOrders = orders.filter(o => o.side === 'buy');
        const sellOrders = orders.filter(o => o.side === 'sell');
        
        if (buyOrders.length > 0) {
          const buyHeight = Math.log10(buyOrders.length + 1) * 2;
          const buyGeometry = new THREE.BoxGeometry(0.2, buyHeight, 1);
          const buyMaterial = new THREE.MeshPhongMaterial({ 
            color: colors.buyColor,
            transparent: true,
            opacity: 0.7
          });
          
          const buyMesh = new THREE.Mesh(buyGeometry, buyMaterial);
          buyMesh.position.set(x, buyHeight / 2, -2);
          
          // Store aggregated order data
          buyMesh.userData = { 
            orderData: {
              price,
              quantity: buyOrders.reduce((sum, o) => sum + o.quantity, 0),
              count: buyOrders.length,
              side: 'buy' as const,
              type: 'aggregate' as any
            }
          };
          
          scene.add(buyMesh);
        }
        
        if (sellOrders.length > 0) {
          const sellHeight = Math.log10(sellOrders.length + 1) * 2;
          const sellGeometry = new THREE.BoxGeometry(0.2, sellHeight, 1);
          const sellMaterial = new THREE.MeshPhongMaterial({ 
            color: colors.sellColor,
            transparent: true,
            opacity: 0.7
          });
          
          const sellMesh = new THREE.Mesh(sellGeometry, sellMaterial);
          sellMesh.position.set(x, sellHeight / 2, 2);
          
          // Store aggregated order data
          sellMesh.userData = { 
            orderData: {
              price,
              quantity: sellOrders.reduce((sum, o) => sum + o.quantity, 0),
              count: sellOrders.length,
              side: 'sell' as const,
              type: 'aggregate' as any
            }
          };
          
          scene.add(sellMesh);
        }
      });
    }

    // Add price level labels
    const loader = new THREE.TextureLoader();
    
    for (let i = 0; i <= 10; i++) {
      const price = priceRange.min + (priceRange.range * i / 10);
      const y = i;
      
      // Create canvas for text
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = 128;
      canvas.height = 64;
      
      if (context) {
        context.fillStyle = 'rgba(0, 0, 0, 0)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.font = 'bold 24px Arial';
        context.fillStyle = isDarkMode ? 'white' : 'black';
        context.textAlign = 'center';
        context.fillText(formatPrice(price), 64, 32);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(material);
        
        // Position based on visualization type
        if (visualizationType === 'time' || visualizationType === '3d') {
          sprite.position.set(-12, y, 0);
        } else {
          sprite.position.set(((price - priceRange.min) / priceRange.range) * 20 - 10, 12, 0);
        }
        
        sprite.scale.set(2, 1, 1);
        scene.add(sprite);
      }
    }

    // Add time labels for time-based visualization
    if (visualizationType === 'time' || visualizationType === '3d') {
      for (let i = 0; i <= 10; i++) {
        const timestamp = minTimestamp + (timeRange * i / 10);
        const x = (i / 10) * 20 - 10;
        
        // Create canvas for text
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 64;
        
        if (context) {
          context.fillStyle = 'rgba(0, 0, 0, 0)';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.font = 'bold 20px Arial';
          context.fillStyle = isDarkMode ? 'white' : 'black';
          context.textAlign = 'center';
          context.fillText(formatTime(new Date(timestamp)), 128, 32);
          
          const texture = new THREE.CanvasTexture(canvas);
          const material = new THREE.SpriteMaterial({ map: texture });
          const sprite = new THREE.Sprite(material);
          sprite.position.set(x, -2, 0);
          sprite.scale.set(5, 1, 1);
          scene.add(sprite);
        }
      }
    }

  }, [processedData, visualizationType, priceRange, colors, isDarkMode]);

  // Handle click on an order
  const handleClick = () => {
    if (hoveredOrder && onOrderClick) {
      onOrderClick(hoveredOrder);
    }
  };

  // Render tooltip for hovered order
  const renderTooltip = () => {
    if (!hoveredOrder) return null;

    return (
      <div className="order-flow-tooltip">
        <div className="tooltip-header">
          <span className={`side-indicator ${hoveredOrder.side}`}>
            {hoveredOrder.side.toUpperCase()}
          </span>
          <span className="type-indicator">
            {hoveredOrder.type === 'aggregate' ? 'AGGREGATE' : hoveredOrder.type.toUpperCase()}
          </span>
        </div>
        
        <div className="tooltip-body">
          <div className="tooltip-row">
            <span className="label">Price:</span>
            <span className="value">{formatPrice(hoveredOrder.price)}</span>
          </div>
          
          <div className="tooltip-row">
            <span className="label">Quantity:</span>
            <span className="value">{formatQuantity(hoveredOrder.quantity)}</span>
          </div>
          
          {hoveredOrder.timestamp && (
            <div className="tooltip-row">
              <span className="label">Time:</span>
              <span className="value">{formatTime(new Date(hoveredOrder.timestamp))}</span>
            </div>
          )}
          
          {hoveredOrder.type === 'aggregate' && hoveredOrder.count && (
            <div className="tooltip-row">
              <span className="label">Orders:</span>
              <span className="value">{hoveredOrder.count}</span>
            </div>
          )}
          
          {hoveredOrder.participantType && (
            <div className="tooltip-row">
              <span className="label">Participant:</span>
              <span className="value">{hoveredOrder.participantType}</span>
            </div>
          )}
          
          {hoveredOrder.isAggressor !== undefined && (
            <div className="tooltip-row">
              <span className="label">Aggressor:</span>
              <span className="value">{hoveredOrder.isAggressor ? 'Yes' : 'No'}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div 
      ref={containerRef} 
      className="order-flow-heatmap"
      style={{ position: 'relative', width: `${width}px`, height: `${height}px` }}
    >
      <div className="visualization-controls">
        <div className="control-group">
          <Button
            variant={visualizationType === 'time' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setVisualizationType('time')}
          >
            Time View
          </Button>
          <Button
            variant={visualizationType === 'price' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setVisualizationType('price')}
          >
            Price View
          </Button>
          <Button
            variant={visualizationType === '3d' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setVisualizationType('3d')}
          >
            3D View
          </Button>
        </div>
        
        <div className="control-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showNewOrders}
              onChange={() => setShowNewOrders(!showNewOrders)}
            />
            New Orders
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showCancelOrders}
              onChange={() => setShowCancelOrders(!showCancelOrders)}
            />
            Cancels
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showTrades}
              onChange={() => setShowTrades(!showTrades)}
            />
            Trades
          </label>
        </div>
        
        <div className="control-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showBuys}
              onChange={() => setShowBuys(!showBuys)}
            />
            Buys
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showSells}
              onChange={() => setShowSells(!showSells)}
            />
            Sells
          </label>
        </div>
      </div>
      
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        width={width}
        height={height}
        style={{ display: 'block' }}
      />
      
      {hoveredOrder && renderTooltip()}
      
      {isLoading && (
        <div className="loading-overlay">
          <Spinner size="large" />
          <p>Loading order flow data...</p>
        </div>
      )}
      
      {error && (
        <div className="error-overlay">
          <p>Error: {error}</p>
        </div>
      )}
      
      <div className="order-flow-info">
        <div className="info-item">
          <span>Symbol: {symbol}</span>
        </div>
        <div className="info-item">
          <span>Venue: {venue}</span>
        </div>
        <div className="info-item">
          <span>Orders: {processedData.length}</span>
        </div>
        <div className="info-item">
          <span>Time Window: {timeWindow} min</span>
        </div>
      </div>
    </div>
  );
};