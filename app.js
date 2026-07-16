// Premium IPTV Player Core Logic

// Dynamic Channel List Database
let channels = [];

// Load channel configurations dynamically from JSON
async function loadChannels() {
  try {
    const response = await fetch('/channels.json');
    if (!response.ok) {
      throw new Error(`HTTP status error: ${response.status}`);
    }
    channels = await response.json();
    return true;
  } catch (err) {
    console.error('Database load error:', err);
    return false;
  }
}

// App State Variables
let shakaPlayer = null;
let shakaUi = null;
let currentChannel = null;
let currentCategory = 'all';
let searchQuery = '';

// DOM Elements
const videoEl = document.getElementById('player');
const videoContainer = document.getElementById('video-container');
const playerOverlay = document.getElementById('player-overlay');
const overlayContent = document.getElementById('overlay-content');
const channelListEl = document.getElementById('channel-list');
const searchInput = document.getElementById('search-input');
const toastEl = document.getElementById('toast');

// UI Channel Meta Elements
const metaBadge = document.getElementById('meta-badge');
const activeTitle = document.getElementById('active-title');
const activeAlias = document.getElementById('active-alias');
const activeDesc = document.getElementById('active-desc');
const refreshBtn = document.getElementById('refresh-btn');
const shareBtn = document.getElementById('share-btn');

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  const databaseLoaded = await loadChannels();
  if (!databaseLoaded) {
    showError('Database Error', 'Unable to fetch the channel list from the server.');
    return;
  }

  setupEventListeners();
  renderCategories();
  
  // Load last watched channel or default to the first one
  const lastChannelId = localStorage.getItem('mxt_last_channel');
  const initialChannel = channels.find(c => c.id === lastChannelId) || channels[0];
  
  // Initialize Shaka Player first
  await initShakaPlayer();
  
  // Select first channel
  selectChannel(initialChannel);
  renderChannelList();
});

// Initialize Shaka Player & UI Overlay
async function initShakaPlayer() {
  shaka.polyfill.installAll();
  
  if (!shaka.Player.isBrowserSupported()) {
    showError('Not Supported', 'Your browser does not support DASH/HLS streaming.');
    return;
  }

  try {
    shakaPlayer = new shaka.Player(videoEl);

    // Initialize UI overlay controls
    shakaUi = new shaka.ui.Overlay(shakaPlayer, videoContainer, videoEl);
    
    // Configure controls UI options
    shakaUi.configure({
      'controlPanelElements': [
        'play_pause',
        'time_and_duration',
        'spacer',
        'mute',
        'volume',
        'quality',
        'playback_rate',
        'fullscreen'
      ],
      'addSeekBar': true
    });

    // Player event listeners
    shakaPlayer.addEventListener('error', (event) => {
      const err = event.detail;
      console.error('Shaka Player Error - Code:', err && err.code, 'Category:', err && err.category, 'Severity:', err && err.severity);
      if (err && err.severity === shaka.util.Error.Severity.CRITICAL) {
        showError('Playback Error', `Critical playback error. (Code: ${err.code})`);
      }
    });

    // Native video elements state listeners for custom loading screens
    videoEl.addEventListener('waiting', () => showLoader());
    videoEl.addEventListener('playing', () => hideOverlay());
    videoEl.addEventListener('seeking', () => showLoader());
    videoEl.addEventListener('seeked', () => hideOverlay());
    videoEl.addEventListener('loadstart', () => showLoader());
    videoEl.addEventListener('canplay', () => hideOverlay());

    // Register Networking Request Filter for proxied streams
    shakaPlayer.getNetworkingEngine().registerRequestFilter((type, request) => {
      if (currentChannel && currentChannel.useProxy !== false) {
        const uri = request.uris[0];
        // Ensure we do not recursively proxy the URL
        if (!uri.startsWith(window.location.origin) && !uri.includes('/proxy?url=')) {
          request.uris = [getProxiedUrl(uri, currentChannel)];
        }
      }
    });

  } catch (err) {
    console.error('Error initializing Shaka Player UI:', err);
    showError('Init Error', 'Failed to initialize the Shaka Player engine.');
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Search Box Event
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderChannelList();
  });

  // Action: Refresh Stream
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (currentChannel) {
        showToast('Refreshing stream...');
        playChannelStream(currentChannel);
      }
    });
  }

  // Action: Copy Share Link
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      if (currentChannel) {
        const shareUrl = `${window.location.origin}${window.location.pathname}?channel=${currentChannel.id}`;
        navigator.clipboard.writeText(shareUrl)
          .then(() => showToast('Share link copied to clipboard!'))
          .catch(() => showToast('Failed to copy link.'));
      }
    });
  }

  // Watch URL params for deep linking
  const urlParams = new URLSearchParams(window.location.search);
  const channelParam = urlParams.get('channel');
  if (channelParam) {
    const matched = channels.find(c => c.id === channelParam);
    if (matched) {
      selectChannel(matched);
    }
  }
}

// Render Channel Categories Filter Count Dynamically
function renderCategories() {
  const container = document.querySelector('.categories-container');
  if (!container) return;

  // Find unique categories from channels
  const uniqueCategories = ['all', ...new Set(channels.map(c => c.category))];
  
  container.innerHTML = uniqueCategories.map(cat => {
    const isActive = currentCategory.toLowerCase() === cat.toLowerCase();
    const displayName = cat === 'all' ? 'All' : cat;
    const count = cat === 'all' ? channels.length : channels.filter(c => c.category.toLowerCase() === cat.toLowerCase()).length;
    return `<button class="category-tab ${isActive ? 'active' : ''}" data-category="${cat}">${displayName} <span class="count">${count}</span></button>`;
  }).join('');

  // Re-bind click event to tabs
  const tabs = container.querySelectorAll('.category-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentCategory = tab.dataset.category;
      renderChannelList();
    });
  });
}

// Render the Sidebar Channel List Card Grid
function renderChannelList() {
  channelListEl.innerHTML = '';
  
  const filteredChannels = channels.filter(channel => {
    const matchesCategory = currentCategory === 'all' || channel.category.toLowerCase() === currentCategory.toLowerCase();
    const matchesSearch = channel.name.toLowerCase().includes(searchQuery) || channel.alias.toLowerCase().includes(searchQuery);
    return matchesCategory && matchesSearch;
  });

  if (filteredChannels.length === 0) {
    channelListEl.innerHTML = `
      <div class="no-results">
        <svg class="no-results-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
        <p>No channels found matching "${searchQuery}"</p>
      </div>
    `;
    return;
  }

  filteredChannels.forEach(channel => {
    const isActive = currentChannel && currentChannel.id === channel.id;
    const card = document.createElement('div');
    card.className = `channel-card ${isActive ? 'active' : ''}`;
    
    // Setup badge class name helper
    let badgeClass = 'badge-hd';
    if (channel.category === 'FHD' || channel.category === 'FULL' || channel.category === 'SportzX') badgeClass = 'badge-fhd';
    if (channel.category === '4K') badgeClass = 'badge-4k';
    if (channel.category === 'DASH') badgeClass = 'badge-dash';
    if (channel.category === 'HLS') badgeClass = 'badge-hls';

    const logoSrc = channel.logo || 'https://tv.motiur.xyz/favicon.png';
    card.innerHTML = `
      <div class="channel-logo-glow" style="background: ${channel.color}">
        <img src="${logoSrc}" alt="${channel.alias}" class="channel-logo-img" onerror="this.style.display='none'; this.parentElement.innerHTML='${channel.logoText}'">
      </div>
      <div class="channel-card-details">
        <div class="channel-card-header">
          <span class="channel-card-name">${channel.alias}</span>
          <span class="channel-card-badge ${badgeClass}">${channel.category}</span>
        </div>
        <span class="channel-card-alias">${channel.name}</span>
      </div>
      ${isActive ? `
        <div class="channel-playing-indicator">
          <div class="equalizer">
            <span class="bar"></span>
            <span class="bar"></span>
            <span class="bar"></span>
          </div>
        </div>
      ` : ''}
    `;

    card.addEventListener('click', () => {
      if (currentChannel && currentChannel.id === channel.id) return;
      selectChannel(channel);
      renderChannelList(); // Re-render to update active status
    });

    channelListEl.appendChild(card);
  });
}

// Select and load a channel
function selectChannel(channel) {
  currentChannel = channel;
  localStorage.setItem('mxt_last_channel', channel.id);

  // Update UI Meta Information
  metaBadge.className = `channel-meta-badge badge-${channel.category.toLowerCase()}`;
  metaBadge.textContent = channel.category;
  activeTitle.textContent = channel.name;
  activeAlias.textContent = channel.alias;
  activeDesc.textContent = channel.desc;

  // Always play stream
  playChannelStream(channel);
}

// Helper to generate proxy URL with custom headers
function getProxiedUrl(originalUrl, channel) {
  if (channel.useProxy === false) {
    return originalUrl;
  }
  let proxyUrl = `${window.location.origin}/proxy?url=${encodeURIComponent(originalUrl)}`;
  if (channel.referer) {
    proxyUrl += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.origin) {
    proxyUrl += `&ori=${encodeURIComponent(channel.origin)}`;
  }
  if (channel.ua || channel['user-agent']) {
    proxyUrl += `&ua=${encodeURIComponent(channel.ua || channel['user-agent'])}`;
  }
  return proxyUrl;
}

// Play channel stream using Shaka Player
async function playChannelStream(channel) {
  showLoader();

  const originalUrl = channel.url;
  const proxyUrl = getProxiedUrl(originalUrl, channel);

  console.log(`Loading Stream: ${originalUrl}`);
  console.log(`Proxied Stream: ${proxyUrl}`);

  try {
    // Clear Keys DRM Configuration
    if (channel.kid && channel.key) {
      shakaPlayer.configure({
        drm: {
          clearKeys: {
            [channel.kid]: channel.key
          }
        }
      });
    } else {
      shakaPlayer.configure({
        drm: {
          clearKeys: {}
        }
      });
    }

    // Load stream into the player
    await shakaPlayer.load(proxyUrl);
    hideOverlay();
    
    videoEl.play().catch(err => {
      console.warn("Autoplay blocked by browser policy, waiting for user click.", err);
      showPlayOverlay();
    });
  } catch (error) {
    console.error('Shaka loading error:', error);
    showError('Load Error', `Unable to load or decrypt the live stream. (Code: ${error.code || 'UNKNOWN'})`);
  }
}

// Overlay helpers
function showLoader() {
  playerOverlay.classList.remove('hidden');
  overlayContent.innerHTML = `
    <div class="spinner"></div>
    <div class="error-title">Loading Stream</div>
    <div class="error-message">Fetching and buffering live broadcast...</div>
  `;
}

function showPlayOverlay() {
  playerOverlay.classList.remove('hidden');
  overlayContent.innerHTML = `
    <button class="retry-btn" onclick="videoEl.play(); hideOverlay();">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
      Click to Play Live
    </button>
  `;
}

function showError(title, message) {
  playerOverlay.classList.remove('hidden');
  overlayContent.innerHTML = `
    <div class="error-icon">✕</div>
    <div class="error-title">${title}</div>
    <div class="error-message">${message}</div>
    <button class="retry-btn" onclick="playChannelStream(currentChannel)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
      </svg>
      Retry Connection
    </button>
  `;
}

// Update DOM elements on overlay hide
function hideOverlay() {
  playerOverlay.classList.add('hidden');
}

// Toast message handler
let toastTimeout;
function showToast(message) {
  clearTimeout(toastTimeout);
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3000);
}
