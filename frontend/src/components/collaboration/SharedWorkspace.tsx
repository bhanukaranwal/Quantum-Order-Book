import React, { useState, useEffect, useCallback } from 'react';
import { useUser } from '../../hooks/useUser';
import { useSocket } from '../../hooks/useSocket';
import { LayoutGrid } from '../layout/LayoutGrid';
import { WorkspaceControls } from './WorkspaceControls';
import { ChatPanel } from './ChatPanel';
import { UserPresence } from './UserPresence';
import { AnnotationLayer } from './AnnotationLayer';
import { PermissionsModal } from './PermissionsModal';
import { ShareModal } from './ShareModal';
import { ActivityLog } from './ActivityLog';

interface SharedWorkspaceProps {
  workspaceId: string;
  initialLayout?: any;
  onLayoutChange?: (layout: any) => void;
}

export const SharedWorkspace: React.FC<SharedWorkspaceProps> = ({
  workspaceId,
  initialLayout,
  onLayoutChange
}) => {
  const { user } = useUser();
  const { socket, connected } = useSocket();
  
  const [workspace, setWorkspace] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeUsers, setActiveUsers] = useState<any[]>([]);
  const [userCursors, setUserCursors] = useState<{[userId: string]: {x: number, y: number}}>({}); 
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [activityOpen, setActivityOpen] = useState<boolean>(false);
  const [showPermissions, setShowPermissions] = useState<boolean>(false);
  const [showShare, setShowShare] = useState<boolean>(false);
  const [layout, setLayout] = useState<any>(initialLayout || {});
  const [annotations, setAnnotations] = useState<any[]>([]);
  
  // Fetch workspace data
  useEffect(() => {
    const fetchWorkspace = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/workspaces/${workspaceId}`);
        
        if (!response.ok) {
          throw new Error('Failed to load workspace');
        }
        
        const data = await response.json();
        setWorkspace(data);
        setLayout(data.layout || initialLayout || {});
        setAnnotations(data.annotations || []);
        setLoading(false);
      } catch (err) {
        setError(`Error loading workspace: ${err.message}`);
        setLoading(false);
      }
    };
    
    fetchWorkspace();
  }, [workspaceId, initialLayout]);
  
  // Set up socket connections for real-time collaboration
  useEffect(() => {
    if (!socket || !connected || !workspaceId) return;
    
    // Join workspace room
    socket.emit('workspace:join', { workspaceId, user });
    
    // Listen for user presence updates
    socket.on('workspace:users', (users) => {
      setActiveUsers(users);
    });
    
    // Listen for cursor movements
    socket.on('workspace:cursor', ({ userId, position }) => {
      setUserCursors(prev => ({
        ...prev,
        [userId]: position
      }));
    });
    
    // Listen for layout changes
    socket.on('workspace:layout', (newLayout) => {
      setLayout(newLayout);
      if (onLayoutChange) {
        onLayoutChange(newLayout);
      }
    });
    
    // Listen for annotation updates
    socket.on('workspace:annotations', (newAnnotations) => {
      setAnnotations(newAnnotations);
    });
    
    // Clean up on unmount
    return () => {
      socket.emit('workspace:leave', { workspaceId, user });
      socket.off('workspace:users');
      socket.off('workspace:cursor');
      socket.off('workspace:layout');
      socket.off('workspace:annotations');
    };
  }, [socket, connected, workspaceId, user, onLayoutChange]);
  
  // Handle mouse movement to broadcast cursor position
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!socket || !connected || !workspaceId) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    
    socket.emit('workspace:cursor', {
      workspaceId,
      position: { x, y }
    });
  }, [socket, connected, workspaceId]);
  
  // Handle layout changes
  const handleLayoutChange = useCallback((newLayout) => {
    setLayout(newLayout);
    
    // Broadcast layout change to other users
    if (socket && connected) {
      socket.emit('workspace:layout', {
        workspaceId,
        layout: newLayout
      });
    }
    
    if (onLayoutChange) {
      onLayoutChange(newLayout);
    }
  }, [socket, connected, workspaceId, onLayoutChange]);
  
  // Add a new annotation
  const addAnnotation = useCallback((annotation) => {
    const newAnnotations = [...annotations, {
      ...annotation,
      id: Date.now().toString(),
      userId: user.id,
      userName: user.name,
      timestamp: new Date().toISOString()
    }];
    
    setAnnotations(newAnnotations);
    
    // Broadcast to other users
    if (socket && connected) {
      socket.emit('workspace:annotations', {
        workspaceId,
        annotations: newAnnotations
      });
    }
  }, [annotations, socket, connected, workspaceId, user]);
  
  // Delete an annotation
  const deleteAnnotation = useCallback((annotationId) => {
    const newAnnotations = annotations.filter(a => a.id !== annotationId);
    
    setAnnotations(newAnnotations);
    
    // Broadcast to other users
    if (socket && connected) {
      socket.emit('workspace:annotations', {
        workspaceId,
        annotations: newAnnotations
      });
    }
  }, [annotations, socket, connected, workspaceId]);
  
  if (loading) {
    return <div className="loading">Loading workspace...</div>;
  }
  
  if (error) {
    return <div className="error">{error}</div>;
  }
  
  return (
    <div 
      className="shared-workspace"
      onMouseMove={handleMouseMove}
    >
      <div className="workspace-header">
        <h1>{workspace.name}</h1>
        <div className="workspace-actions">
          <UserPresence users={activeUsers} />
          
          <WorkspaceControls 
            canEdit={workspace.permissions?.canEdit}
            onToggleChat={() => setChatOpen(!chatOpen)}
            onToggleActivity={() => setActivityOpen(!activityOpen)}
            onOpenPermissions={() => setShowPermissions(true)}
            onShare={() => setShowShare(true)}
          />
        </div>
      </div>
      
      <div className="workspace-content">
        <LayoutGrid 
          layout={layout}
          onLayoutChange={handleLayoutChange}
          editable={workspace.permissions?.canEdit}
        />
        
        <AnnotationLayer 
          annotations={annotations}
          onAddAnnotation={addAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          editable={workspace.permissions?.canEdit}
        />
        
        {/* Render user cursors */}
        {Object.entries(userCursors).map(([userId, position]) => {
          const user = activeUsers.find(u => u.id === userId);
          if (!user || userId === user.id) return null;
          
          return (
            <div 
              key={`cursor-${userId}`}
              className="remote-cursor"
              style={{
                left: `${position.x}%`,
                top: `${position.y}%`,
                backgroundColor: user.color || '#ff0000'
              }}
            >
              <div className="cursor-name">{user.name}</div>
            </div>
          );
        })}
      </div>
      
      {chatOpen && (
        <ChatPanel 
          workspaceId={workspaceId}
          onClose={() => setChatOpen(false)}
        />
      )}
      
      {activityOpen && (
        <ActivityLog 
          workspaceId={workspaceId}
          onClose={() => setActivityOpen(false)}
        />
      )}
      
      {showPermissions && (
        <PermissionsModal
          workspaceId={workspaceId}
          currentPermissions={workspace.permissions}
          onClose={() => setShowPermissions(false)}
        />
      )}
      
      {showShare && (
        <ShareModal
          workspaceId={workspaceId}
          workspaceName={workspace.name}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
};