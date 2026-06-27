const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;

// Determine the storage path (detecting Render persistent disk mounts)
let uploadsDir = path.join(__dirname, 'public', 'uploads');

if (fs.existsSync('/public/uploads')) {
    uploadsDir = '/public/uploads';
    console.log('[STORAGE] Using Render absolute mount disk at: /public/uploads');
} else if (fs.existsSync('/opt/render/project/src/public/uploads')) {
    uploadsDir = '/opt/render/project/src/public/uploads';
    console.log('[STORAGE] Using Render absolute source disk at: /opt/render/project/src/public/uploads');
} else {
    console.log(`[STORAGE] Using local directory: ${uploadsDir}`);
}

if (!fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
        console.warn(`[STORAGE] Error creating directory ${uploadsDir}:`, err.message);
    }
}

// Global State (Multi-Screen)
let state = {
    mediaLibrary: [],      // Global library of uploaded files: { id, name, filename, type }
    screens: {
        "default": {
            name: "Big LED Screen",
            playlist: [],  // Array of: { id, name, filename, type: 'video'|'image'|'temp', duration: 10 }
            currentIndex: -1,
            isPlaying: false,
            volume: 1.0,
            isBlackout: false,
            ticker: {
                enabled: false,
                text: 'Welcome to The Dome Namibia',
                speed: 5,
                color: '#ffffff',
                bgColor: 'rgba(0, 0, 0, 0.6)'
            },
            blackoutSchedule: {
                enabled: false,
                onTime: '22:00',
                offTime: '08:00'
            },
            lastScheduledState: null
        }
    },
    savedPlaylists: [],    // Array of: { name: 'Morning Ads', playlist: [...] }
    screenConfig: {
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080
    },
    domeManagementApiUrl: '',
    spotifyConfig: null
};

// Load saved state if exists
const stateFile = path.join(uploadsDir, 'state.json');
function loadState() {
    // Migration: if state.json is in root, move it to public/uploads
    const oldStateFile = path.join(__dirname, 'state.json');
    
    if (fs.existsSync(oldStateFile) && !fs.existsSync(stateFile)) {
        try {
            fs.renameSync(oldStateFile, stateFile);
            console.log('[MIGRATION] Moved state.json from root to public/uploads/');
        } catch (err) {
            console.warn('[MIGRATION] Failed to move state.json:', err.message);
        }
    }

    if (fs.existsSync(stateFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            state = { ...state, ...data };
            // Stop playback on start for all screens to be safe
            for (let sid in state.screens) {
                state.screens[sid].isPlaying = false;
                if (!state.screens[sid].blackoutSchedule) {
                    state.screens[sid].blackoutSchedule = {
                        enabled: false,
                        onTime: '22:00',
                        offTime: '08:00'
                    };
                }
                if (state.screens[sid].lastScheduledState === undefined) {
                    state.screens[sid].lastScheduledState = null;
                }
            }
        } catch (e) {
            console.error('Error reading state file, using defaults.', e);
        }
    }
}
loadState();

function saveState() {
    try {
        const uploadsDir = path.dirname(stateFile);
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('Error writing state file:', e);
    }
}

// Ensure a screen exists in state
function ensureScreenExists(screenId) {
    if (!state.screens[screenId]) {
        state.screens[screenId] = {
            name: screenId.charAt(0).toUpperCase() + screenId.slice(1) + " Screen",
            playlist: [],
            currentIndex: -1,
            isPlaying: false,
            volume: 1.0,
            isBlackout: false,
            ticker: {
                enabled: false,
                text: 'Welcome to The Dome',
                speed: 5,
                color: '#ffffff',
                bgColor: 'rgba(0, 0, 0, 0.6)'
            },
            blackoutSchedule: {
                enabled: false,
                onTime: '22:00',
                offTime: '08:00'
            },
            lastScheduledState: null
        };
        saveState();
    }
}

// Broadcast helper
function broadcastGlobalState() {
    const adminMessage = JSON.stringify({ type: 'GLOBAL_STATE_UPDATE', state });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (client.screenId === 'admin') {
                client.send(adminMessage);
            }
        }
    });
}

function broadcastScreenState(screenId) {
    ensureScreenExists(screenId);
    const playerMessage = JSON.stringify({ 
        type: 'STATE_UPDATE', 
        screenId, 
        state: state.screens[screenId],
        screenConfig: state.screenConfig 
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (client.screenId === screenId) {
                client.send(playerMessage);
            }
        }
    });
}

// Multer Storage config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|mp4|webm|mov/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('Only images (jpg/png/gif) and videos (mp4/webm/mov) are allowed!'));
    }
});

// Middleware
app.use(express.json());

// Explicitly serve uploads folder from the calculated uploadsDir
app.use('/uploads', express.static(uploadsDir, {
    maxAge: '1y',
    setHeaders: (res, filePath, stat) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

// REST Endpoints
app.get('/api/state', (req, res) => {
    res.json(state);
});

// Get temperatures endpoint
app.get('/api/temps', async (req, res) => {
    const mockTemps = { outdoor: 17.5, mainHall: 21.0 };
    if (state.domeManagementApiUrl) {
        try {
            let fetchUrl = state.domeManagementApiUrl;
            // Auto-append /api/state if only the domain is provided
            if (fetchUrl.endsWith('.com') || fetchUrl.endsWith('.com/')) {
                fetchUrl = fetchUrl.replace(/\/$/, '') + '/api/state';
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(fetchUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (response.ok) {
                const data = await response.json();
                
                // Parse from the building management stateCache structure if present
                let outdoor = mockTemps.outdoor;
                let mainHall = mockTemps.mainHall;
                
                if (data.utilities) {
                    outdoor = data.utilities.outside_temp !== undefined ? data.utilities.outside_temp : outdoor;
                    mainHall = data.utilities.hall_temp !== undefined ? data.utilities.hall_temp : mainHall;
                } else {
                    outdoor = data.outdoor !== undefined ? data.outdoor : (data.out !== undefined ? data.out : outdoor);
                    mainHall = data.mainHall !== undefined ? data.mainHall : (data.hall !== undefined ? data.hall : mainHall);
                }
                
                return res.json({ outdoor, mainHall });
            }
        } catch (e) {
            console.warn('Could not fetch from Dome Management API, returning fallbacks:', e.message);
        }
    }
    res.json(mockTemps);
});

// Get temperature history endpoint
app.get('/api/temps/history', async (req, res) => {
    if (!state.domeManagementApiUrl) {
        return res.json([]);
    }
    
    try {
        let fetchUrl = state.domeManagementApiUrl;
        if (fetchUrl.endsWith('.com') || fetchUrl.endsWith('.com/')) {
            fetchUrl = fetchUrl.replace(/\/$/, '') + '/api/utilities/history?requester=Shaun';
        } else {
            fetchUrl = fetchUrl.replace(/\/$/, '') + '/api/utilities/history?requester=Shaun';
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(fetchUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) {
                const hallTemps = data
                    .filter(item => item.key === 'hall_temp' && item.value !== undefined)
                    .map(item => ({
                        time: item.timestamp,
                        value: parseFloat(item.value)
                    }));
                return res.json(hallTemps.slice(-144)); // last 24 hours (10 min intervals)
            }
        }
    } catch (e) {
        console.warn('Could not fetch temperature history from Dome API:', e.message);
    }
    
    // Fallback Mock data
    const mockHistory = [];
    const now = Date.now();
    for (let i = 24 * 6; i >= 0; i--) {
        const time = new Date(now - i * 10 * 60 * 1000);
        const hour = time.getHours();
        const baseHallTemp = 18.4 + 1.5 * Math.sin((hour - 8) * Math.PI / 12);
        mockHistory.push({
            time: time.toISOString().replace('T', ' ').substring(0, 19),
            value: parseFloat((baseHallTemp + Math.sin(i / 10) * 0.5).toFixed(1))
        });
    }
    res.json(mockHistory);
});

// Save playlist endpoint
app.post('/api/playlists/save', (req, res) => {
    const { name, screenId } = req.body;
    const sid = screenId || 'default';
    if (!name) {
        return res.status(400).json({ error: 'Playlist name is required' });
    }
    
    ensureScreenExists(sid);
    const existingIndex = state.savedPlaylists.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    const playlistCopy = JSON.parse(JSON.stringify(state.screens[sid].playlist));
    
    if (existingIndex !== -1) {
        state.savedPlaylists[existingIndex].playlist = playlistCopy;
    } else {
        state.savedPlaylists.push({ name, playlist: playlistCopy });
    }
    
    saveState();
    broadcastGlobalState();
    res.json({ success: true, savedPlaylists: state.savedPlaylists });
});

// Load playlist endpoint
app.post('/api/playlists/load/:name', (req, res) => {
    const name = req.params.name;
    const screenId = req.query.screenId || 'default';
    
    ensureScreenExists(screenId);
    const saved = state.savedPlaylists.find(p => p.name.toLowerCase() === name.toLowerCase());
    
    if (!saved) {
        return res.status(404).json({ error: 'Playlist not found' });
    }
    
    state.screens[screenId].playlist = JSON.parse(JSON.stringify(saved.playlist));
    state.screens[screenId].currentIndex = state.screens[screenId].playlist.length > 0 ? 0 : -1;
    state.screens[screenId].isPlaying = false; // Stop playback for safety
    
    saveState();
    broadcastGlobalState();
    broadcastScreenState(screenId);
    res.json({ success: true, playlist: state.screens[screenId].playlist });
});

// Delete playlist endpoint
app.delete('/api/playlists/:name', (req, res) => {
    const name = req.params.name;
    const index = state.savedPlaylists.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    
    if (index === -1) {
        return res.status(404).json({ error: 'Playlist not found' });
    }
    
    state.savedPlaylists.splice(index, 1);
    saveState();
    broadcastGlobalState();
    res.json({ success: true, savedPlaylists: state.savedPlaylists });
});

// File Upload endpoint (adds to Global Media Library)
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const newItem = {
        id: 'media-' + Date.now(),
        name: req.file.originalname,
        filename: req.file.filename,
        type: fileType
    };

    state.mediaLibrary.push(newItem);
    
    saveState();
    broadcastGlobalState();
    res.json({ success: true, item: newItem });
});

// Delete global media library item
app.delete('/api/library/:id', (req, res) => {
    const id = req.params.id;
    const index = state.mediaLibrary.findIndex(item => item.id === id);
    
    if (index !== -1) {
        const item = state.mediaLibrary[index];
        const filePath = path.join(uploadsDir, item.filename);
        
        // Delete file from disk
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error('Error deleting file:', filePath, e);
            }
        }
        
        // Remove item from global library
        state.mediaLibrary.splice(index, 1);

        // Also clean up references in all screen playlists!
        for (let sid in state.screens) {
            const screen = state.screens[sid];
            const pIndex = screen.playlist.findIndex(p => p.filename === item.filename);
            if (pIndex !== -1) {
                screen.playlist.splice(pIndex, 1);
                // Adjust current index
                if (screen.playlist.length === 0) {
                    screen.currentIndex = -1;
                    screen.isPlaying = false;
                } else if (screen.currentIndex >= screen.playlist.length) {
                    screen.currentIndex = screen.playlist.length - 1;
                }
                broadcastScreenState(sid);
            }
        }
        
        saveState();
        broadcastGlobalState();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Media not found in library' });
    }
});

// Spotify OAuth Endpoints
app.post('/api/spotify/exchange', async (req, res) => {
    const { code, client_id, client_secret, redirect_uri } = req.body;
    if (!code || !client_id || !client_secret || !redirect_uri) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
        const authHeader = 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64');
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', redirect_uri);

        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        const data = await response.json();
        if (response.status === 200 && data.access_token) {
            state.spotifyConfig = {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || (state.spotifyConfig ? state.spotifyConfig.refreshToken : ''),
                tokenExpiry: Date.now() + (data.expires_in * 1000),
                clientId: client_id,
                clientSecret: client_secret,
                wasPlayingBeforeBlackout: (state.spotifyConfig ? state.spotifyConfig.wasPlayingBeforeBlackout : false),
                lastDeviceId: (state.spotifyConfig ? state.spotifyConfig.lastDeviceId : '')
            };
            saveState();
            console.log('[SPOTIFY-SERVER] Successfully exchanged and saved Spotify config.');
        }
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Error exchanging Spotify code:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

app.post('/api/spotify/refresh', async (req, res) => {
    const { refresh_token, client_id, client_secret } = req.body;
    if (!refresh_token || !client_id || !client_secret) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
        const authHeader = 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64');
        const params = new URLSearchParams();
        params.append('grant_type', 'refresh_token');
        params.append('refresh_token', refresh_token);

        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        const data = await response.json();
        if (response.status === 200 && data.access_token) {
            state.spotifyConfig = {
                ...state.spotifyConfig,
                accessToken: data.access_token,
                refreshToken: data.refresh_token || state.spotifyConfig.refreshToken,
                tokenExpiry: Date.now() + (data.expires_in * 1000),
                clientId: client_id,
                clientSecret: client_secret
            };
            saveState();
            console.log('[SPOTIFY-SERVER] Successfully refreshed and saved Spotify config.');
        }
        res.status(response.status).json(data);
    } catch (error) {
        console.error('Error refreshing Spotify token:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

// Spotify Server-Side playback control helpers
async function getOrRefreshSpotifyToken() {
    if (!state.spotifyConfig || !state.spotifyConfig.refreshToken) return null;
    const { accessToken, tokenExpiry, refreshToken, clientId, clientSecret } = state.spotifyConfig;

    // Check if expired or expiring within 60s
    if (Date.now() + 60000 > tokenExpiry) {
        console.log('[SPOTIFY-SERVER] Token expiring soon. Refreshing on server...');
        try {
            const authHeader = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
            const params = new URLSearchParams();
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', refreshToken);

            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            });

            if (response.status === 200) {
                const data = await response.json();
                state.spotifyConfig.accessToken = data.access_token;
                state.spotifyConfig.tokenExpiry = Date.now() + (data.expires_in * 1000);
                if (data.refresh_token) {
                    state.spotifyConfig.refreshToken = data.refresh_token;
                }
                saveState();
                console.log('[SPOTIFY-SERVER] Token refreshed successfully.');
                return state.spotifyConfig.accessToken;
            } else {
                console.error('[SPOTIFY-SERVER] Failed to refresh token. Status:', response.status);
                return null;
            }
        } catch (error) {
            console.error('[SPOTIFY-SERVER] Error refreshing token:', error);
            return null;
        }
    }
    return accessToken;
}

async function spotifyServerAction(action) {
    if (!state.spotifyConfig) {
        console.log('[SPOTIFY-SERVER] Spotify is not configured, skipping blackout action:', action);
        return;
    }
    const token = await getOrRefreshSpotifyToken();
    if (!token) {
        console.log('[SPOTIFY-SERVER] No valid token, cannot perform action:', action);
        return;
    }

    if (action === 'pause') {
        console.log('[SPOTIFY-SERVER] Sending Pause request to Spotify...');
        try {
            // First check if currently playing to decide whether to resume on wake
            const playingRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            let wasPlaying = false;
            let currentDeviceId = state.spotifyConfig.lastDeviceId;

            if (playingRes.status === 200) {
                const playingData = await playingRes.json();
                wasPlaying = !!(playingData && playingData.is_playing);
            }
            
            // Get active devices to save device ID
            const devicesRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (devicesRes.status === 200) {
                const devicesData = await devicesRes.json();
                if (devicesData && devicesData.devices) {
                    const activeDev = devicesData.devices.find(d => d.is_active);
                    if (activeDev) {
                        currentDeviceId = activeDev.id;
                    }
                }
            }

            // Perform Pause request
            const pauseRes = await fetch('https://api.spotify.com/v1/me/player/pause', {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            console.log('[SPOTIFY-SERVER] Pause response status:', pauseRes.status);
            // If it succeeds (204) OR if it was already playing according to API, mark wasPlaying as true
            const finalWasPlaying = (pauseRes.status === 204) || wasPlaying;
            state.spotifyConfig.wasPlayingBeforeBlackout = finalWasPlaying;
            if (currentDeviceId) {
                state.spotifyConfig.lastDeviceId = currentDeviceId;
            }
            saveState();
            console.log(`[SPOTIFY-SERVER] Saved wasPlayingBeforeBlackout = ${finalWasPlaying}, deviceId = ${currentDeviceId}`);
        } catch (err) {
            console.error('[SPOTIFY-SERVER] Error during auto-pause:', err);
        }
    } else if (action === 'resume') {
        if (!state.spotifyConfig.wasPlayingBeforeBlackout) {
            console.log('[SPOTIFY-SERVER] Spotify was not playing before blackout, skipping resume.');
            return;
        }

        console.log('[SPOTIFY-SERVER] Sending Resume request to Spotify...');
        try {
            const deviceId = state.spotifyConfig.lastDeviceId;
            let resumeRes;
            if (deviceId) {
                console.log('[SPOTIFY-SERVER] Resuming on device ID:', deviceId);
                // Call Transfer Playback with play = true to wake it up
                resumeRes = await fetch('https://api.spotify.com/v1/me/player', {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ device_ids: [deviceId], play: true })
                });
            } else {
                console.log('[SPOTIFY-SERVER] Resuming on default active device...');
                resumeRes = await fetch('https://api.spotify.com/v1/me/player/play', {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }
            console.log('[SPOTIFY-SERVER] Resume response status:', resumeRes.status);
            
            // Clean up wasPlaying flag
            state.spotifyConfig.wasPlayingBeforeBlackout = false;
            saveState();
        } catch (err) {
            console.error('[SPOTIFY-SERVER] Error during auto-resume:', err);
        }
    }
}


// WebSocket Handler
wss.on('connection', (ws, req) => {
    // Parse screenId from URL query string
    const urlParams = new URL(req.url, 'http://localhost');
    const screenId = urlParams.searchParams.get('screenId') || 'default';
    
    ws.screenId = screenId;
    ensureScreenExists(screenId);

    // Initial state push
    if (screenId === 'admin') {
        ws.send(JSON.stringify({ type: 'GLOBAL_STATE_UPDATE', state }));
    } else {
        ws.send(JSON.stringify({ 
            type: 'STATE_UPDATE', 
            screenId, 
            state: state.screens[screenId],
            screenConfig: state.screenConfig 
        }));
    }

    ws.on('message', (messageString) => {
        try {
            const data = JSON.parse(messageString);
            
            // If the message is from Admin panel, it targets a specific screen
            const sid = data.screenId || screenId;
            ensureScreenExists(sid);
            const screen = state.screens[sid];

            switch (data.type) {
                case 'PLAY':
                    screen.isPlaying = true;
                    if (data.index !== undefined) {
                        screen.currentIndex = data.index;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'PAUSE':
                    screen.isPlaying = false;
                    broadcastScreenState(sid);
                    break;
                case 'STOP':
                    screen.isPlaying = false;
                    screen.currentIndex = screen.playlist.length > 0 ? 0 : -1;
                    broadcastScreenState(sid);
                    break;
                case 'NEXT':
                    if (screen.playlist.length > 0) {
                        screen.currentIndex = (screen.currentIndex + 1) % screen.playlist.length;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'PREV':
                    if (screen.playlist.length > 0) {
                        screen.currentIndex = (screen.currentIndex - 1 + screen.playlist.length) % screen.playlist.length;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'SET_INDEX':
                    if (data.index >= 0 && data.index < screen.playlist.length) {
                        screen.currentIndex = data.index;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'SET_VOLUME':
                    screen.volume = Math.max(0.0, Math.min(1.0, data.volume));
                    broadcastScreenState(sid);
                    break;
                case 'SET_BLACKOUT':
                    screen.isBlackout = !!data.value;
                    broadcastScreenState(sid);
                    if (sid === 'default') {
                        if (screen.isBlackout) {
                            spotifyServerAction('pause');
                        } else {
                            spotifyServerAction('resume');
                        }
                    }
                    break;
                case 'UPDATE_TICKER':
                    screen.ticker = { ...screen.ticker, ...data.ticker };
                    broadcastScreenState(sid);
                    break;
                case 'UPDATE_SCREEN_CONFIG':
                    state.screenConfig = { ...state.screenConfig, ...data.config };
                    saveState();
                    broadcastGlobalState();
                    for (let screenKey in state.screens) {
                        broadcastScreenState(screenKey);
                    }
                    break;
                case 'UPDATE_DURATION':
                    const item = screen.playlist.find(p => p.id === data.id);
                    if (item && (item.type === 'image' || item.type === 'temp')) {
                        item.duration = Math.max(1, parseInt(data.duration) || 10);
                    }
                    broadcastScreenState(sid);
                    break;
                case 'ADD_TEMP_SLIDE':
                    const newTemp = {
                        id: 'temp-' + Date.now(),
                        name: 'Dome Live Temperatures',
                        type: 'temp',
                        duration: parseInt(data.duration) || 15,
                        label1: 'Outdoor Temperature',
                        label2: 'Main Hall Temperature',
                        showGraph: true,
                        historyHours: 6
                    };
                    screen.playlist.push(newTemp);
                    if (screen.currentIndex === -1) {
                        screen.currentIndex = 0;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'UPDATE_TEMP_LABELS':
                    const tempItem = screen.playlist.find(p => p.id === data.id);
                    if (tempItem && tempItem.type === 'temp') {
                        tempItem.label1 = data.label1 || 'Outdoor Temperature';
                        tempItem.label2 = data.label2 || 'Main Hall Temperature';
                        tempItem.showGraph = data.showGraph !== undefined ? !!data.showGraph : tempItem.showGraph;
                        tempItem.boldFont = data.boldFont !== undefined ? !!data.boldFont : tempItem.boldFont;
                        tempItem.historyHours = data.historyHours !== undefined ? parseInt(data.historyHours) : (tempItem.historyHours || 24);
                    }
                    broadcastScreenState(sid);
                    break;
                case 'ADD_LIBRARY_ITEM_TO_PLAYLIST':
                    const libItem = state.mediaLibrary.find(l => l.id === data.libraryId);
                    if (libItem) {
                        const playlistItem = {
                            id: 'item-' + Date.now() + '-' + Math.round(Math.random() * 1000),
                            name: libItem.name,
                            filename: libItem.filename,
                            type: libItem.type,
                            duration: libItem.type === 'image' ? 10 : null
                        };
                        screen.playlist.push(playlistItem);
                        if (screen.currentIndex === -1) {
                            screen.currentIndex = 0;
                        }
                        broadcastScreenState(sid);
                    }
                    break;
                case 'REMOVE_PLAYLIST_ITEM':
                    const pIndex = screen.playlist.findIndex(p => p.id === data.id);
                    if (pIndex !== -1) {
                        screen.playlist.splice(pIndex, 1);
                        if (screen.playlist.length === 0) {
                            screen.currentIndex = -1;
                            screen.isPlaying = false;
                        } else if (screen.currentIndex >= screen.playlist.length) {
                            screen.currentIndex = screen.playlist.length - 1;
                        }
                        broadcastScreenState(sid);
                    }
                    break;
                case 'REORDER_PLAYLIST':
                    if (Array.isArray(data.newOrder)) {
                        const reordered = [];
                        data.newOrder.forEach(id => {
                            const pItem = screen.playlist.find(p => p.id === id);
                            if (pItem) reordered.push(pItem);
                        });
                        screen.playlist = reordered;
                        broadcastScreenState(sid);
                    }
                    break;
                case 'SET_DOME_API_URL':
                    state.domeManagementApiUrl = data.url;
                    break;
                case 'REMOTE_PC_CONTROL':
                    const controlAction = data.action;
                    const targetSid = data.targetScreenId || 'default';
                    const { exec } = require('child_process');
                    if (controlAction === 'launch') {
                        const config = state.screenConfig || {};
                        const url = `http://localhost:${PORT}/player.html?screenId=${targetSid}&width=${config.width || 960}&height=${config.height || 192}`;
                        console.log(`[REMOTE] Launching player browser for screen "${targetSid}" at: ${url}`);
                        exec(`start chrome --start-fullscreen "${url}"`, (err) => {
                            if (err) {
                                console.warn('[REMOTE] Chrome launch failed, trying Edge...');
                                exec(`start msedge --start-fullscreen "${url}"`, (err2) => {
                                    if (err2) {
                                        console.warn('[REMOTE] Edge launch failed, trying default system browser...');
                                        exec(`start "${url}"`);
                                    }
                                });
                            }
                        });
                    } else if (controlAction === 'close') {
                        console.log('[REMOTE] Closing player browsers on host PC...');
                        exec('taskkill /F /IM chrome.exe', (err) => {
                            if (err) console.warn('[REMOTE] Failed to taskkill chrome.exe:', err.message);
                            exec('taskkill /F /IM msedge.exe', (err2) => {
                                if (err2) console.warn('[REMOTE] Failed to taskkill msedge.exe:', err2.message);
                            });
                        });
                    }
                    break;
                case 'UPDATE_VIDEO_SOUND':
                    const videoItem = screen.playlist.find(p => p.id === data.id);
                    if (videoItem && videoItem.type === 'video') {
                        videoItem.muted = !data.sound;
                    }
                    broadcastScreenState(sid);
                    break;
                case 'UPDATE_BLACKOUT_SCHEDULE':
                    screen.blackoutSchedule = {
                        enabled: !!data.enabled,
                        onTime: data.onTime || '22:00',
                        offTime: data.offTime || '08:00'
                    };
                    // Reset lastScheduledState so that it triggers evaluation immediately
                    screen.lastScheduledState = null;
                    broadcastScreenState(sid);
                    break;
                case 'DELETE_SCREEN':
                    // Prevent deleting default screen
                    if (data.targetScreenId && data.targetScreenId !== 'default') {
                        delete state.screens[data.targetScreenId];
                    }
                    break;
                case 'SPOTIFY_SYNC_DEVICE':
                    if (state.spotifyConfig) {
                        state.spotifyConfig.lastDeviceId = data.deviceId;
                    }
                    break;
                case 'SPOTIFY_DISCONNECT':
                    state.spotifyConfig = null;
                    break;
            }
            
            saveState();
            broadcastGlobalState();
        } catch (e) {
            console.error('Error handling WebSocket message:', e);
        }
    });
});

// Fallback HTML router
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Blackout scheduler check (runs every 10 seconds to respond quickly to scheduled times)
setInterval(() => {
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "Africa/Windhoek",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        let hours = '00';
        let minutes = '00';
        for (const part of parts) {
            if (part.type === 'hour') hours = part.value;
            if (part.type === 'minute') minutes = part.value;
        }
        if (hours === '24') hours = '00';
        const currentTime = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;

        let stateChanged = false;

        for (let sid in state.screens) {
            const screen = state.screens[sid];
            if (screen.blackoutSchedule && screen.blackoutSchedule.enabled) {
                const { onTime, offTime } = screen.blackoutSchedule;
                if (onTime && offTime) {
                    let shouldBeBlackout = false;
                    if (onTime < offTime) {
                        // e.g., 08:00 to 17:00
                        shouldBeBlackout = (currentTime >= onTime && currentTime < offTime);
                    } else {
                        // e.g., 22:00 to 06:00 (overnight blackout)
                        shouldBeBlackout = (currentTime >= onTime || currentTime < offTime);
                    }

                    if (screen.lastScheduledState !== shouldBeBlackout) {
                        console.log(`[SCHEDULE] Toggling blackout for screen "${sid}" to ${shouldBeBlackout} (Current time: ${currentTime}, Schedule: ${onTime} - ${offTime})`);
                        screen.isBlackout = shouldBeBlackout;
                        screen.lastScheduledState = shouldBeBlackout;
                        stateChanged = true;
                        broadcastScreenState(sid);
                        
                        // Trigger Spotify server action on schedule-driven blackout change
                        if (sid === 'default') {
                            if (shouldBeBlackout) {
                                spotifyServerAction('pause');
                            } else {
                                spotifyServerAction('resume');
                            }
                        }
                    }
                }
            }
        }

        if (stateChanged) {
            saveState();
            broadcastGlobalState();
        }
    } catch (err) {
        console.error('Error running blackout schedule check:', err);
    }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "Africa/Windhoek",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
    console.log(`=========================================`);
    console.log(` NovaRemote Server is running!`);
    console.log(` Current Namibia time: ${formatter.format(new Date())}`);
    console.log(` Web Admin Dashboard: http://localhost:${PORT}/`);
    console.log(` Remote Access:       http://<your-pc-ip>:${PORT}/`);
    console.log(` Player Screen:       http://localhost:${PORT}/player.html`);
    console.log(`=========================================`);
});
