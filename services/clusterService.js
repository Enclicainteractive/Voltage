const Redis = require('redis')
const os = require('os')
const crypto = require('crypto')

class ClusterService {
  constructor() {
    this.nodeId = this.generateNodeId()
    this.isLeader = false
    this.nodes = new Map()
    this.redisClient = null
    this.redisSubscriber = null
    this.redisPublisher = null
    this.heartbeatInterval = null
    this.leaderElectionInterval = null
    this.config = {
      heartbeatIntervalMs: 5000,
      nodeTimeoutMs: 15000,
      leaderTimeoutMs: 20000,
      redisPrefix: 'voltchat:cluster:'
    }
  }

  generateNodeId() {
    const hostname = os.hostname()
    const pid = process.pid
    const timestamp = Date.now()
    const random = crypto.randomBytes(4).toString('hex')
    return `${hostname}-${pid}-${timestamp}-${random}`
  }

  async initialize(redisConfig = {}) {
    try {
      // Initialize Redis connections
      const redisOptions = {
        host: redisConfig.host || process.env.REDIS_HOST || 'localhost',
        port: redisConfig.port || process.env.REDIS_PORT || 6379,
        password: redisConfig.password || process.env.REDIS_PASSWORD,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      }

      this.redisClient = Redis.createClient(redisOptions)
      this.redisSubscriber = this.redisClient.duplicate()
      this.redisPublisher = this.redisClient.duplicate()

      await Promise.all([
        this.redisClient.connect(),
        this.redisSubscriber.connect(),
        this.redisPublisher.connect()
      ])

      // Set up cluster communication channels
      await this.setupClusterChannels()

      // Register this node
      await this.registerNode()

      // Start heartbeat and leader election
      this.startHeartbeat()
      this.startLeaderElection()

      console.log(`[ClusterService] Node ${this.nodeId} initialized successfully`)
      return true
    } catch (error) {
      console.error('[ClusterService] Failed to initialize:', error)
      return false
    }
  }

  async setupClusterChannels() {
    // Subscribe to cluster events
    await this.redisSubscriber.subscribe([
      `${this.config.redisPrefix}events`,
      `${this.config.redisPrefix}heartbeat`,
      `${this.config.redisPrefix}leader-election`,
      `${this.config.redisPrefix}websocket-events`
    ])

    this.redisSubscriber.on('message', (channel, message) => {
      this.handleClusterMessage(channel, message)
    })
  }

  handleClusterMessage(channel, message) {
    try {
      const data = JSON.parse(message)
      
      switch (channel) {
        case `${this.config.redisPrefix}heartbeat`:
          this.handleHeartbeat(data)
          break
        case `${this.config.redisPrefix}leader-election`:
          this.handleLeaderElection(data)
          break
        case `${this.config.redisPrefix}websocket-events`:
          this.handleWebSocketEvent(data)
          break
        case `${this.config.redisPrefix}events`:
          this.handleClusterEvent(data)
          break
      }
    } catch (error) {
      console.error('[ClusterService] Error handling cluster message:', error)
    }
  }

  async registerNode() {
    const nodeInfo = {
      id: this.nodeId,
      hostname: os.hostname(),
      pid: process.pid,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      lastHeartbeat: Date.now(),
      isLeader: false,
      connections: 0,
      load: os.loadavg()[0]
    }

    await this.redisClient.hSet(
      `${this.config.redisPrefix}nodes`,
      this.nodeId,
      JSON.stringify(nodeInfo)
    )

    // Set expiration for auto-cleanup
    await this.redisClient.expire(
      `${this.config.redisPrefix}nodes:${this.nodeId}`,
      this.config.nodeTimeoutMs / 1000
    )
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.sendHeartbeat()
        await this.checkNodeHealth()
      } catch (error) {
        console.error('[ClusterService] Heartbeat error:', error)
      }
    }, this.config.heartbeatIntervalMs)
  }

  async sendHeartbeat() {
    const heartbeat = {
      nodeId: this.nodeId,
      timestamp: Date.now(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      load: os.loadavg()[0],
      isLeader: this.isLeader,
      connections: this.getConnectionCount()
    }

    await this.redisPublisher.publish(
      `${this.config.redisPrefix}heartbeat`,
      JSON.stringify(heartbeat)
    )

    // Update node info in Redis
    await this.redisClient.hSet(
      `${this.config.redisPrefix}nodes`,
      this.nodeId,
      JSON.stringify(heartbeat)
    )
  }

  handleHeartbeat(data) {
    if (data.nodeId !== this.nodeId) {
      this.nodes.set(data.nodeId, {
        ...data,
        lastSeen: Date.now()
      })
    }
  }

  async checkNodeHealth() {
    const now = Date.now()
    const deadNodes = []

    // Check for dead nodes
    for (const [nodeId, nodeInfo] of this.nodes) {
      if (now - nodeInfo.lastSeen > this.config.nodeTimeoutMs) {
        deadNodes.push(nodeId)
      }
    }

    // Remove dead nodes
    for (const nodeId of deadNodes) {
      this.nodes.delete(nodeId)
      await this.redisClient.hDel(`${this.config.redisPrefix}nodes`, nodeId)
      console.log(`[ClusterService] Removed dead node: ${nodeId}`)
    }
  }

  startLeaderElection() {
    this.leaderElectionInterval = setInterval(async () => {
      await this.performLeaderElection()
    }, this.config.heartbeatIntervalMs)
  }

  async performLeaderElection() {
    try {
      const currentLeader = await this.redisClient.get(`${this.config.redisPrefix}leader`)
      const now = Date.now()

      if (!currentLeader || this.isLeaderExpired(currentLeader)) {
        // Try to become leader
        const result = await this.redisClient.set(
          `${this.config.redisPrefix}leader`,
          JSON.stringify({
            nodeId: this.nodeId,
            timestamp: now,
            hostname: os.hostname()
          }),
          {
            PX: this.config.leaderTimeoutMs,
            NX: true // Only set if not exists
          }
        )

        if (result === 'OK') {
          this.becomeLeader()
        }
      } else {
        const leader = JSON.parse(currentLeader)
        if (leader.nodeId === this.nodeId) {
          // Extend leadership
          await this.redisClient.set(
            `${this.config.redisPrefix}leader`,
            JSON.stringify({
              nodeId: this.nodeId,
              timestamp: now,
              hostname: os.hostname()
            }),
            { PX: this.config.leaderTimeoutMs }
          )
        } else {
          this.isLeader = false
        }
      }
    } catch (error) {
      console.error('[ClusterService] Leader election error:', error)
    }
  }

  isLeaderExpired(leaderData) {
    try {
      const leader = JSON.parse(leaderData)
      return Date.now() - leader.timestamp > this.config.leaderTimeoutMs
    } catch {
      return true
    }
  }

  becomeLeader() {
    if (!this.isLeader) {
      this.isLeader = true
      console.log(`[ClusterService] Node ${this.nodeId} became cluster leader`)
      this.onBecomeLeader()
    }
  }

  onBecomeLeader() {
    // Leader-specific tasks
    this.startClusterMaintenance()
  }

  startClusterMaintenance() {
    // Perform cluster maintenance tasks as leader
    setInterval(async () => {
      if (this.isLeader) {
        await this.performClusterMaintenance()
      }
    }, 30000) // Every 30 seconds
  }

  async performClusterMaintenance() {
    try {
      // Clean up expired data
      await this.cleanupExpiredData()
      
      // Balance load if needed
      await this.performLoadBalancing()
      
      // Emit cluster stats
      await this.emitClusterStats()
    } catch (error) {
      console.error('[ClusterService] Cluster maintenance error:', error)
    }
  }

  async cleanupExpiredData() {
    const keys = await this.redisClient.keys(`${this.config.redisPrefix}*`)
    for (const key of keys) {
      const ttl = await this.redisClient.ttl(key)
      if (ttl === -1) { // No expiration set
        await this.redisClient.expire(key, 3600) // Set 1 hour default
      }
    }
  }

  async performLoadBalancing() {
    const nodes = Array.from(this.nodes.values())
    if (nodes.length < 2) return

    // Calculate average load
    const totalLoad = nodes.reduce((sum, node) => sum + node.load, 0)
    const avgLoad = totalLoad / nodes.length
    const threshold = avgLoad * 1.5

    // Find overloaded nodes
    const overloadedNodes = nodes.filter(node => node.load > threshold)
    const underloadedNodes = nodes.filter(node => node.load < avgLoad * 0.7)

    if (overloadedNodes.length > 0 && underloadedNodes.length > 0) {
      await this.redistributeLoad(overloadedNodes, underloadedNodes)
    }
  }

  async redistributeLoad(overloadedNodes, underloadedNodes) {
    for (const overloaded of overloadedNodes) {
      const target = underloadedNodes[Math.floor(Math.random() * underloadedNodes.length)]
      
      await this.redisPublisher.publish(
        `${this.config.redisPrefix}events`,
        JSON.stringify({
          type: 'load-balance',
          from: overloaded.nodeId,
          to: target.nodeId,
          action: 'redistribute-connections'
        })
      )
    }
  }

  async emitClusterStats() {
    const stats = {
      totalNodes: this.nodes.size + 1, // +1 for this node
      leader: this.nodeId,
      totalConnections: Array.from(this.nodes.values())
        .reduce((sum, node) => sum + node.connections, this.getConnectionCount()),
      avgLoad: Array.from(this.nodes.values())
        .reduce((sum, node) => sum + node.load, os.loadavg()[0]) / (this.nodes.size + 1),
      timestamp: Date.now()
    }

    await this.redisPublisher.publish(
      `${this.config.redisPrefix}events`,
      JSON.stringify({
        type: 'cluster-stats',
        stats
      })
    )
  }

  // WebSocket scaling methods
  async broadcastToCluster(event, data, excludeNodeId = null) {
    const message = {
      event,
      data,
      sourceNodeId: this.nodeId,
      timestamp: Date.now()
    }

    await this.redisPublisher.publish(
      `${this.config.redisPrefix}websocket-events`,
      JSON.stringify(message)
    )
  }

  handleWebSocketEvent(message) {
    // Don't handle our own messages
    if (message.sourceNodeId === this.nodeId) return

    // Emit to local WebSocket connections
    if (this.socketServer) {
      this.socketServer.emit(message.event, message.data)
    }
  }

  // Socket.IO adapter integration
  setSocketServer(socketServer) {
    this.socketServer = socketServer
  }

  getConnectionCount() {
    return this.socketServer ? this.socketServer.engine.clientsCount : 0
  }

  // Node discovery and routing
  async getOptimalNode(criteria = {}) {
    const nodes = Array.from(this.nodes.values())
    if (nodes.length === 0) return null

    // Sort by load and connection count
    return nodes.sort((a, b) => {
      const scoreA = (a.load * 0.6) + (a.connections * 0.4)
      const scoreB = (b.load * 0.6) + (b.connections * 0.4)
      return scoreA - scoreB
    })[0]
  }

  async getAllNodes() {
    const nodes = await this.redisClient.hGetAll(`${this.config.redisPrefix}nodes`)
    return Object.entries(nodes).map(([id, data]) => JSON.parse(data))
  }

  handleClusterEvent(data) {
    switch (data.type) {
      case 'cluster-stats':
        console.log('[ClusterService] Cluster stats:', data.stats)
        break
      case 'load-balance':
        this.handleLoadBalanceEvent(data)
        break
    }
  }

  handleLoadBalanceEvent(data) {
    if (data.from === this.nodeId) {
      // This node should reduce load
      console.log(`[ClusterService] Reducing load, targeting node ${data.to}`)
    } else if (data.to === this.nodeId) {
      // This node should accept more load
      console.log(`[ClusterService] Accepting additional load from ${data.from}`)
    }
  }

  async shutdown() {
    try {
      // Clear intervals
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval)
      }
      if (this.leaderElectionInterval) {
        clearInterval(this.leaderElectionInterval)
      }

      // Remove from cluster
      await this.redisClient.hDel(`${this.config.redisPrefix}nodes`, this.nodeId)
      
      // If we're the leader, release leadership
      if (this.isLeader) {
        await this.redisClient.del(`${this.config.redisPrefix}leader`)
      }

      // Close Redis connections
      await Promise.all([
        this.redisClient.disconnect(),
        this.redisSubscriber.disconnect(),
        this.redisPublisher.disconnect()
      ])

      console.log(`[ClusterService] Node ${this.nodeId} shutdown complete`)
    } catch (error) {
      console.error('[ClusterService] Shutdown error:', error)
    }
  }
}

module.exports = ClusterService