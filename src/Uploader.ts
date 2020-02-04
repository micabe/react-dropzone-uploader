const uploader = function() {
  function Uploader() {
    this.chunkSize = 1024 * 1024
    this.threadsQuantity = 5
    this.file = null
    this.url = null
    this.aborted = false
    this.uploadedSize = 0
    this.progressCache = {}
    this.activeConnections = {}
  }

  Uploader.prototype.setOptions = function(options = {}) {
    this.chunkSize = options.chunkSize
    this.url = options.url
  }

  Uploader.prototype.setupFile = function(file) {
    if (!file) {
      return
    }

    this.file = file
  }

  Uploader.prototype.start = function() {
    if (!this.file) {
      throw new Error("Can't start uploading: file have not chosen")
    }

    const chunksQuantity = Math.ceil(this.file.size / this.chunkSize)
    this.chunksQueue = new Array(chunksQuantity)
      .fill()
      .map((_, index) => index)
      .reverse()

    const xhr = new XMLHttpRequest()

    xhr.open('post', `${this.url}/init`)

    xhr.setRequestHeader('X-Chunks-Quantity', String(chunksQuantity))

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const response = JSON.parse(xhr.responseText)

        if (!response.fileId || !response.totalChunks) {
          this.complete(new Error("Can't create file id"))
          return
        }

        this.fileId = response.fileId
        this.totalChunks = response.totalChunks
        this.sendNext()
      }
    }

    xhr.onerror = error => {
      this.complete(error)
    }

    xhr.send()
  }

  Uploader.prototype.sendNext = function() {
    const activeConnections = Object.keys(this.activeConnections).length

    if (activeConnections >= this.threadsQuantity) {
      return
    }

    if (!this.chunksQueue.length) {
      if (!activeConnections) {
        this.complete(null)
      }

      return
    }

    const chunkId = this.chunksQueue.pop()
    const sentSize = chunkId * this.chunkSize
    const chunk = this.file.slice(sentSize, sentSize + this.chunkSize)

    this.sendChunk(chunk, chunkId, this.totalChunks - this.chunksQueue.length)
      .then(() => {
        this.sendNext()
      })
      .catch(error => {
        this.chunksQueue.push(chunkId)

        this.complete(error)
      })

    this.sendNext()
  }

  Uploader.prototype.complete = function(error) {
    if (error && !this.aborted) {
      this.end(error)
      return
    }

    this.end(error)
  }

  Uploader.prototype.sendChunk = function(chunk, id, number) {
    return new Promise(async (resolve, reject) => {
      try {
        const status = await this.upload(chunk, id, number)

        if (status !== 201) {
          reject(new Error('Failed chunk upload'))
          return
        }
      } catch (error) {
        reject(error)
        return
      }

      resolve()
    })
  }

  Uploader.prototype.handleProgress = function(chunkId, event) {
    if (event.type === 'progress' || event.type === 'error' || event.type === 'abort') {
      this.progressCache[chunkId] = event.loaded
    }

    if (event.type === 'loadend') {
      this.uploadedSize += this.progressCache[chunkId] || 0
      delete this.progressCache[chunkId]
    }

    const inProgress = Object.keys(this.progressCache).reduce((memo, id) => (memo += this.progressCache[id]), 0)

    const sendedLength = Math.min(this.uploadedSize + inProgress, this.file.size)

    this.onProgress({
      loaded: sendedLength,
      total: this.file.size,
    })
  }

  Uploader.prototype.upload = function(file, id, number) {
    return new Promise((resolve, reject) => {
      const xhr = (this.activeConnections[id] = new XMLHttpRequest())
      const progressListener = this.handleProgress.bind(this, id)

      xhr.upload.addEventListener('progress', progressListener)

      xhr.addEventListener('error', progressListener)
      xhr.addEventListener('abort', progressListener)
      xhr.addEventListener('loadend', progressListener)

      xhr.open('post', this.url)

      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('X-Chunk-Number', number)
      xhr.setRequestHeader('X-Content-Id', this.fileId)
      xhr.setRequestHeader('X-Chunk-Id', id)
      xhr.setRequestHeader('X-Chunks-Quantity', this.totalChunks)
      xhr.setRequestHeader('X-Content-Name', this.file.name)

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4 && xhr.status === 201) {
          resolve(xhr.status)
          delete this.activeConnections[id]
        }
      }

      xhr.onerror = error => {
        reject(error)
        delete this.activeConnections[id]
      }

      xhr.onabort = () => {
        reject(new Error('Upload canceled by user'))
        delete this.activeConnections[id]
      }

      xhr.send(file)
    })
  }

  Uploader.prototype.on = function(method, callback) {
    if (typeof callback !== 'function') {
      callback = () => {}
    }

    this[method] = callback
  }

  Uploader.prototype.abort = function() {
    Object.keys(this.activeConnections).forEach(id => {
      this.activeConnections[id].abort()
    })

    this.aborted = true
  }

  const multithreadedUploader = new Uploader()

  return {
    options: function(options) {
      multithreadedUploader.setOptions(options)

      return this
    },
    send: function(file) {
      multithreadedUploader.setupFile(file)

      return this
    },
    continue: function() {
      multithreadedUploader.sendNext()
    },
    onProgress: function(callback) {
      multithreadedUploader.on('onProgress', callback)

      return this
    },
    end: function(callback) {
      multithreadedUploader.on('end', callback)
      multithreadedUploader.start()

      return this
    },
    abort: function() {
      multithreadedUploader.abort()
    },
  }
}

export const getTimeCounter = () => {
  const start = +new Date()

  return () => {
    return +new Date() - start
  }
}

export default uploader
