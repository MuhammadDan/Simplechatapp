// Chat application with Socket Adapter support Rellience
const socket = io({
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  transports: ['polling', 'websocket']
});

// DOM elements
const usernameInput = document.getElementById('username');
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('m');
const notification = document.getElementById('notification');
const setUsernameBtn = document.getElementById('set-username');
const sendBtn = document.getElementById('send');

// Application state
let myName = localStorage.getItem('chat_username') || '';
const pendingMessages = new Map();
let tempIdCounter = 1;
let isOnline = navigator.onLine;
let isTyping = false;
let typingTimeout = null;

// Create connection status element
const statusDiv = document.createElement('div');
statusDiv.id = 'connection-status';
statusDiv.style.cssText = `
  position: fixed;
  top: 10px;
  left: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  background: #28a745;
  color: white;
  z-index: 1000;
  display: none;
  box-shadow: 0 2px 5px rgba(0,0,0,0.2);
`;
document.body.appendChild(statusDiv);

// Socket event handlers
socket.on('connect', () => {
  console.log(' Connected to server via SocketAdapter');
  isOnline = true;
  updateConnectionStatus(' Connected', '#28a745');
  showNotification('Connected to chat server', false);
});

socket.on('disconnect', (reason) => {
  console.log(' Disconnected:', reason);
  isOnline = false;
  updateConnectionStatus(' Disconnected', '#dc3545');
  showNotification('Disconnected from server', true);
});

socket.on('reconnect', () => {
  console.log(' Reconnected to server');
  updateConnectionStatus(' Connected', '#28a745');
  showNotification('Reconnected to server', false);
});

socket.on('reconnect_attempt', (attemptNumber) => {
  updateConnectionStatus(` Connecting... (Attempt ${attemptNumber})`, '#ffc107');
});

socket.on('reconnect_error', (error) => {
  console.log('Reconnection error:', error);
});

socket.on('chat message', handleIncomingMessage);

socket.on('user_typing', (data) => {
  if (data.user !== myName) {
    showTypingIndicator(data.user, data.isTyping);
  }
});

socket.on('heartbeat', (data) => {
  console.log('❤️ Heartbeat received:', data.timestamp);
});

// Initialize
if (myName) usernameInput.value = myName;

// Event Listeners
setUsernameBtn.addEventListener('click', setUsername);
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', handleKeyPress);
msgInput.addEventListener('input', handleTyping);

// Online/Offline detection
window.addEventListener('online', () => {
  console.log('🌐 Browser is online');
  isOnline = true;
  updateConnectionStatus('🌐 Online - Connecting...', '#ffc107');
});

window.addEventListener('offline', () => {
  console.log('🌐 Browser is offline');
  isOnline = false;
  updateConnectionStatus('🌐 Offline', '#6c757d');
  showNotification('You are offline. Messages will be sent when connection is restored.', true);
});

// Functions
function updateConnectionStatus(text, color) {
  statusDiv.textContent = text;
  statusDiv.style.backgroundColor = color;
  statusDiv.style.display = 'block';
}

function setUsername() {
  const name = usernameInput.value.trim();
  if (!name) {
    showNotification('Please enter a name.', true);
    return;
  }
  myName = name;
  localStorage.setItem('chat_username', myName);
  showNotification(`Name set to: ${myName}`);
}

function handleKeyPress(e) {
  if (e.key === 'Enter') {
    sendMessage();
  }
}

function handleTyping() {
  if (!myName) return;
  
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing', { username: myName });
  }
  
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    if (isTyping) {
      isTyping = false;
      socket.emit('stop_typing', { username: myName });
    }
  }, 1000);
}

function showTypingIndicator(user, isTyping) {
  let indicator = document.getElementById('typing-indicator');
  
  if (isTyping) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'typing-indicator';
      indicator.style.cssText = `
        font-style: italic;
        color: #666;
        padding: 5px 10px;
        font-size: 12px;
      `;
      messagesEl.appendChild(indicator);
    }
    indicator.textContent = `${user} is typing...`;
    indicator.style.display = 'block';
  } else if (indicator) {
    indicator.style.display = 'none';
  }
}

function sendMessage() {
  const text = msgInput.value.trim();
  const username = (myName || usernameInput.value || 'Anonymous').trim();

  if (!text) {
    showNotification('Please enter a message', true);
    return;
  }

  // Clear typing indicator
  if (isTyping) {
    isTyping = false;
    socket.emit('stop_typing', { username: myName });
    clearTimeout(typingTimeout);
  }

  // Create temporary message
  const tempId = `temp-${tempIdCounter++}`;
  const li = createMessageElement({
    id: tempId,
    sender: username,
    text: text,
    createdAt: new Date(),
    isPending: true,
    status: '⏳ Sending...'
  });
  
  messagesEl.appendChild(li);
  scrollToBottom();

  // Store reference
  pendingMessages.set(tempId, { li, username, text });

  // Send with acknowledgement via SocketAdapter
  socket.emit('chat message', { username, text }, (acknowledgement) => {
    handleAcknowledgement(tempId, acknowledgement);
  });

  msgInput.value = '';
  msgInput.focus();
}

function handleAcknowledgement(tempId, acknowledgement) {
  const pending = pendingMessages.get(tempId);
  if (!pending) return;

  pendingMessages.delete(tempId);

  if (acknowledgement.status === 'success') {
    updateMessageElement(pending.li, {
      id: acknowledgement.messageId,
      sender: acknowledgement.sender,
      text: acknowledgement.text,
      createdAt: new Date(acknowledgement.timestamp),
      status: '✓ Delivered',
      serverTime: acknowledgement.serverTime
    });
    pending.li.classList.remove('pending');
    pending.li.classList.add('me');
    
    showNotification(`Message sent at ${new Date(acknowledgement.serverTime).toLocaleTimeString()}`);
  } else {
    pending.li.classList.remove('pending');
    pending.li.classList.add('error');
    updateMessageElement(pending.li, {
      status: `✗ ${acknowledgement.message || acknowledgement.error}`,
      code: acknowledgement.code
    });
    
    showNotification(`Failed to send: ${acknowledgement.message || acknowledgement.error}`, true);
    
    // Add retry button
    addRetryButton(pending.li, pending.username, pending.text);
  }
}

function addRetryButton(li, username, text) {
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry';
  retryBtn.style.cssText = `
    margin-left: 10px;
    padding: 2px 8px;
    font-size: 10px;
    background: #dc3545;
    color: white;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  `;
  
  retryBtn.onclick = () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';
    
    // Clear error styling temporarily
    li.classList.remove('error');
    li.classList.add('pending');
    updateMessageElement(li, { status: '⏳ Retrying...' });
    
    socket.emit('chat message', { username, text }, (acknowledgement) => {
      if (acknowledgement.status === 'success') {
        updateMessageElement(li, {
          status: '✓ Delivered (Retried)'
        });
        li.classList.remove('pending');
        li.classList.add('me');
        retryBtn.remove();
      } else {
        li.classList.remove('pending');
        li.classList.add('error');
        updateMessageElement(li, {
          status: `✗ ${acknowledgement.message}`
        });
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
      }
    });
  };
  
  const meta = li.querySelector('.meta');
  meta.appendChild(retryBtn);
}

function handleIncomingMessage(msg) {
  // Don't show our own broadcast messages (they're shown via acknowledgement)
  if (msg.sender === myName && msg.isBroadcast && !msg.isOwnMessage) {
    return;
  }

  const li = createMessageElement({
    id: msg.id,
    sender: msg.sender,
    text: msg.text,
    createdAt: new Date(msg.createdAt),
    status: msg.isOwnMessage ? '✓ Sent' : '📨 Received'
  });
  
  if (msg.sender === myName) {
    li.classList.add('me');
  }
  
  messagesEl.appendChild(li);
  scrollToBottom();
}

function createMessageElement(msg) {
  const li = document.createElement('li');

  // Set classes
  if (msg.isPending) {
    li.classList.add('pending');
  } else if (msg.sender === myName) {
    li.classList.add('me');
  }

  // Content
  const content = document.createElement('div');
  content.innerHTML = `<strong>${msg.sender}:</strong> ${escapeHtml(msg.text)}`;
  li.appendChild(content);

  // Metadata
  const meta = document.createElement('div');
  meta.className = 'meta';
  
  const timeText = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  }) : '';
  
  meta.textContent = timeText;

  if (msg.status) {
    const statusSpan = document.createElement('span');
    statusSpan.className = 'status';
    statusSpan.textContent = ` ${msg.status}`;
    meta.appendChild(statusSpan);
  }

  if (msg.serverTime) {
    const serverSpan = document.createElement('span');
    serverSpan.className = 'server-time';
    serverSpan.style.cssText = 'font-size: 9px; color: #888; margin-left: 5px;';
    serverSpan.textContent = `(server: ${new Date(msg.serverTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    meta.appendChild(serverSpan);
  }

  li.appendChild(meta);
  li.dataset.messageId = msg.id;

  return li;
}

function updateMessageElement(li, updates) {
  if (updates.sender && updates.text) {
    li.querySelector('div').innerHTML = `
      <strong>${updates.sender}:</strong> ${escapeHtml(updates.text)}
    `;
  }

  const meta = li.querySelector('.meta');
  if (updates.createdAt) {
    const timeText = new Date(updates.createdAt).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    meta.textContent = timeText;
  }

  if (updates.status) {
    let statusSpan = li.querySelector('.status');
    if (!statusSpan) {
      statusSpan = document.createElement('span');
      statusSpan.className = 'status';
      meta.appendChild(statusSpan);
    }
    statusSpan.textContent = ` ${updates.status}`;
  }

  if (updates.id) {
    li.dataset.messageId = updates.id;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNotification(message, isError = false) {
  notification.textContent = message;
  notification.className = isError ? 'error' : '';
  notification.style.display = 'block';

  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

function scrollToBottom() {
  messagesEl.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// Load previous messages
function loadPreviousMessages() {
  fetch('/api/messages')
    .then((r) => {
      if (!r.ok) throw new Error('Failed to load messages');
      return r.json();
    })
    .then((items) => {
      items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      items.forEach((m) => {
        const li = createMessageElement({
          id: m.id,
          sender: m.username,
          text: m.text,
          createdAt: new Date(m.createdAt),
          status: m.username === myName ? '✓ Delivered' : '📨 Received'
        });

        if (m.username === myName) {
          li.classList.add('me');
        }

        messagesEl.appendChild(li);
      });

      scrollToBottom();
    })
    .catch((err) => {
      console.error('Failed to load messages:', err);
      showNotification('Could not load previous messages', true);
    });
}

// Check server health
function checkServerHealth() {
  fetch('/health')
    .then(r => r.json())
    .then(data => {
      console.log('Server health:', data);
      if (data.status === 'healthy') {
        updateConnectionStatus(' Healthy', '#28a745');
      } else {
        updateConnectionStatus(' Issues Detected', '#ffc107');
      }
    })
    .catch(err => {
      console.error('Health check failed:', err);
      updateConnectionStatus('❌ Server Unreachable', '#dc3545');
    });
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  loadPreviousMessages();
  checkServerHealth();
  
  // Periodic health check
  setInterval(checkServerHealth, 30000);
});