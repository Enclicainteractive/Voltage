/**
 * Cluster Integration Service
 * 
 * Provides clustering and load balancing integration for the main server
 * Handles Redis adapter setup, cluster service initialization, and WebSocket scaling
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Import CommonJS cluster services
const ClusterService = require('./clusterService.js')
const { createRedisAdapter } = require('./redisAdapter.js')
const { clusterConfig } = require('../config/cluster.js')

class ClusterIntegration {
  constructor() {
    this.clusterService = null
    this.redisAdapter = null
    this.initialized = false
    this.isClusterMode = process.env.CLUSTER_MODE !== 'false'
  }

  async initialize(io, options = {}) {
    try {
      console.log('[ClusterIntegration] Initializing cluster services...')
      
      // Initialize cluster service for multi-server coordination
      if (this.isClusterMode && clusterConfig.redis.host) {
        this.clusterService = new ClusterService()
        const clusterInitialized = await this.clusterService.initialize(clusterConfig.redis)
        
        if (clusterInitialized) {
          // Set up WebSocket server reference
          this.clusterService.setSocketServer(io)
          console.log('[ClusterIntegration] Cluster service initialized')
        } else {
          console.warn('[ClusterIntegration] Cluster service failed to initialize, continuing without clustering')
        }
      }

      // Initialize Redis adapter for Socket.IO clustering
      if (io && clusterConfig.redis.host) {
        this.redisAdapter = createRedisAdapter({
          ...clusterConfig.redis,
          nodeId: this.clusterService?.nodeId || `node-${process.pid}-${Date.now()}`
        })

        // Apply Redis adapter to Socket.IO
        io.adapter(this.redisAdapter)
        
        // Initialize the adapter
        if (io.of('/').adapter.init) {
          await io.of('/').adapter.init()
        }
        
        console.log('[ClusterIntegration] Redis adapter initialized for Socket.IO')
      }

      // Set up cluster event handlers
      this.setupClusterEvents(io)

      this.initialized = true
      console.log('[ClusterIntegration] Cluster integration initialized successfully')
      
      return true
    } catch (error) {
      console.error('[ClusterIntegration] Failed to initialize cluster services:', error)
      return false
    }
  }

  setupClusterEvents(io) {
    if (!this.clusterService) return

    // Handle cluster-wide WebSocket events
    io.on('connection', (socket) => {
      // Track connection count for load balancing
      global.socketConnections = (global.socketConnections || 0) + 1

      socket.on('disconnect', () => {
        global.socketConnections = Math.max(0, (global.socketConnections || 0) - 1)
      })

      // Broadcast user join/leave events to cluster
      socket.on('user-connected', async (data) => {
        await this.clusterService.broadcastToCluster('user-connected', {
          userId: data.userId,
          serverId: data.serverId,
          nodeId: this.clusterService.nodeId
        })
      })

      socket.on('user-disconnected', async (data) => {
        await this.clusterService.broadcastToCluster('user-disconnected', {
          userId: data.userId,
          serverId: data.serverId,
          nodeId: this.clusterService.nodeId
        })
      })

      // Handle cross-server messaging
      socket.on('message', async (data) => {
        // Broadcast message to all nodes in cluster
        await this.clusterService.broadcastToCluster('message', {
          ...data,
          sourceNode: this.clusterService.nodeId
        })
      })
    })

    // Handle health check requests from master process
    if (process.send) {
      process.on('message', (message) => {
        if (message.type === 'health-check') {
          const stats = this.getHealthStats(io)
          process.send({
            type: 'health-response',
            ...stats,
            timestamp: Date.now()
          })
        }
      })
    }
  }

  getHealthStats(io) {
    const memUsage = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    
    return {
      memory: memUsage.heapUsed,
      cpu: cpuUsage.user + cpuUsage.system,
      connections: global.socketConnections || 0,
      uptime: process.uptime(),
      pid: process.pid,
      nodeId: this.clusterService?.nodeId
    }
  }

  async broadcastToCluster(event, data) {
    if (this.clusterService) {
      await this.clusterService.broadcastToCluster(event, data)
    }
  }

  async getClusterStats() {
    if (!this.initialized) return null

    const stats = {
      cluster: null,
      socketIO: null
    }

    // Get cluster service stats
    if (this.clusterService) {
      const nodes = await this.clusterService.getAllNodes()
      stats.cluster = {
        nodeId: this.clusterService.nodeId,
        isLeader: this.clusterService.isLeader,
        totalNodes: nodes.length,
        nodes: nodes.map(node => ({
          id: node.id,
          hostname: node.hostname,
          load: node.load,
          connections: node.connections,
          uptime: node.uptime
        }))
      }
    }

    // Get Socket.IO adapter stats
    if (this.redisAdapter && typeof this.redisAdapter.getClusterStats === 'function') {
      stats.socketIO = await this.redisAdapter.getClusterStats()
    }

    return stats
  }

  async getOptimalNode(criteria = {}) {
    if (this.clusterService) {
      return await this.clusterService.getOptimalNode(criteria)
    }
    return null
  }

  async shutdown() {
    try {
      console.log('[ClusterIntegration] Shutting down cluster services...')
      
      if (this.redisAdapter && typeof this.redisAdapter.close === 'function') {
        await this.redisAdapter.close()
      }
      
      if (this.clusterService) {
        await this.clusterService.shutdown()
      }
      
      console.log('[ClusterIntegration] Cluster integration shutdown complete')
    } catch (error) {
      console.error('[ClusterIntegration] Error during shutdown:', error)
    }
  }

  // Utility methods for cluster management
  isClusterEnabled() {
    return this.isClusterMode && this.initialized
  }

  getNodeId() {
    return this.clusterService?.nodeId || `single-node-${process.pid}`
  }

  isLeader() {
    return this.clusterService?.isLeader || true // Single node is always leader
  }

  async waitForClusterReady(timeout = 10000) {
    if (!this.isClusterMode) return true

    const start = Date.now()
    while (!this.initialized && (Date.now() - start) < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    return this.initialized
  }

  // Methods for handling distributed operations
  async distributeUserSession(userId, sessionData) {
    if (this.clusterService) {
      await this.clusterService.broadcastToCluster('user-session-update', {
        userId,
        sessionData,
        timestamp: Date.now()
      })
    }
  }

  async distributeServerUpdate(serverId, updateData) {
    if (this.clusterService) {
      await this.clusterService.broadcastToCluster('server-update', {
        serverId,
        updateData,
        timestamp: Date.now()
      })
    }
  }

  async distributeChannelUpdate(channelId, updateData) {
    if (this.clusterService) {
      await this.clusterService.broadcastToCluster('channel-update', {
        channelId,
        updateData,
        timestamp: Date.now()
      })
    }
  }

  // Load balancing helpers
  async getLoadBalancingInfo() {
    if (!this.clusterService) {
      return {
        currentLoad: global.socketConnections || 0,
        canAcceptConnections: true,
        nodeId: this.getNodeId()
      }
    }

    const nodes = await this.clusterService.getAllNodes()
    const currentNode = nodes.find(n => n.id === this.clusterService.nodeId) || {}
    
    return {
      currentLoad: currentNode.connections || 0,
      cpuLoad: currentNode.load || 0,
      memory: currentNode.memory || 0,
      canAcceptConnections: (currentNode.load || 0) < clusterConfig.loadBalancing.loadThreshold,
      nodeId: this.clusterService.nodeId,
      totalNodes: nodes.length
    }
  }
}

// Singleton instance
let clusterIntegration = null

export function getClusterIntegration() {
  if (!clusterIntegration) {
    clusterIntegration = new ClusterIntegration()
  }
  return clusterIntegration
}

export default ClusterIntegration