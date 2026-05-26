// ==========================================================================
// BINGO DIGITAL PREMIUM - LÓGICA FRONTEND SPA (REAL-TIME POLLING)
// ==========================================================================

const API_BASE = window.location.origin;

// Fetch Interceptor para manejar tokens expirados de forma global
const originalFetch = window.fetch;
window.fetch = async function() {
    const response = await originalFetch.apply(this, arguments);
    if (response.status === 401) {
        // Evitar que salten muchos popups si hay varios requests en paralelo
        if (state.user !== null) {
            showToast("Sesión expirada. Por favor, inicia sesión nuevamente.", "error");
            handleLogout();
        }
    }
    return response;
};

// --- SISTEMA PREMIUM DE TOASTS GLASSMORPHIC ---
function showToast(message, type = 'info') {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `bingo-toast bingo-toast-${type}`;

    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    else if (type === 'error') icon = 'fa-circle-exclamation';
    else if (type === 'warning') icon = 'fa-triangle-exclamation';

    toast.innerHTML = `
        <div class="bingo-toast-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="bingo-toast-content">${message}</div>
    `;

    container.appendChild(toast);

    // Forzar reflow
    toast.offsetHeight;
    toast.classList.add("show");

    // Auto-destrucción
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

// Estado Global de la Aplicación
let state = {
    user: null, // { token, username, rol }
    activePartida: null, // Partida activa en el lobby
    gameState: null, // Estado del juego (bolas, tickets de usuario, ganadores)
    selectedTableId: null, // Tabla seleccionada en el catálogo
    activeGameTableId: null, // Tabla seleccionada en el área de juego
    autoDaub: true, // Auto-marcado de cartones habilitado
    daubedCells: {}, // Registro manual de celdas marcadas por el usuario { ticketId_posicion_r_c: true }
    pollerInterval: null,
    adminPollerInterval: null,
    announcedWinners: new Set() // Registro de ganadores mostrados para evitar popups duplicados
};

// Coordenadas del patrón libre
let customPatternSelectedCoords = [];

// --- INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", () => {
    // Restaurar sesión de localStorage
    const savedUser = localStorage.getItem("bingo_user");
    if (savedUser) {
        state.user = JSON.parse(savedUser);
    }
    
    updateHeaderUI();
    initAppRouting();
    startBackgroundPollers();
});

// --- ENRUTAMIENTO Y VISTAS (SPA) ---
function initAppRouting() {
    if (!state.user) {
        showScreen("screen-auth");
    } else {
        showScreen("screen-lobby");
        if (state.user.rol === 'ADMIN') {
            // Cargar datos del catálogo por si acaso
            renderCatalogNumbers();
        }
    }
}

function showScreen(screenId) {
    // Apagar poller de juego si salimos del cuarto de juego
    if (screenId !== 'screen-game' && state.pollerInterval) {
        clearInterval(state.pollerInterval);
        state.pollerInterval = null;
    }
    
    // Apagar poller de admin si salimos de admin
    if (screenId !== 'screen-admin' && state.adminPollerInterval) {
        clearInterval(state.adminPollerInterval);
        state.adminPollerInterval = null;
    }

    // Cambiar clase activa en pantallas
    document.querySelectorAll(".app-screen").forEach(s => s.classList.remove("active"));
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.add("active");
    }
    
    // Acciones especiales al entrar a pantallas
    if (screenId === 'screen-lobby') {
        fetchLobbyState();
    } else if (screenId === 'screen-catalog') {
        renderCatalogNumbers();
    } else if (screenId === 'screen-game') {
        state.announcedWinners.clear();
        fetchGameState();
        // Polling de alta frecuencia para juego en vivo (cada 2.5s)
        if (!state.pollerInterval) {
            state.pollerInterval = setInterval(fetchGameState, 2500);
        }
    } else if (screenId === 'screen-admin') {
        fetchAdminSales();
        fetchAdminAllTickets();
        fetchAdminState();
        if (!state.adminPollerInterval) {
            state.adminPollerInterval = setInterval(() => {
                fetchAdminSales();
                fetchAdminAllTickets();
                fetchAdminState();
            }, 2500);
        }
    }

    // Actualizar menú de navegación activo
    document.querySelectorAll(".nav-item").forEach(item => {
        if (item.getAttribute("onclick").includes(screenId)) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });
}

function updateHeaderUI() {
    const navMenu = document.getElementById("nav-menu");
    const userBadge = document.getElementById("user-badge");
    
    if (!state.user) {
        navMenu.innerHTML = '';
        userBadge.innerHTML = '';
        return;
    }

    // Crear barra de navegación premium
    let menuHTML = `<button class="nav-item" onclick="showScreen('screen-lobby')"><i class="fa-solid fa-house"></i> Lobby</button>`;
    
    if (state.user.rol === 'JUGADOR') {
        menuHTML += `<button class="nav-item" onclick="showScreen('screen-catalog')"><i class="fa-solid fa-cart-shopping"></i> Comprar Tabla</button>`;
    }
    
    // Si hay juego en curso, agregar acceso directo al Play Room
    menuHTML += `<button class="nav-item" onclick="showScreen('screen-game')"><i class="fa-solid fa-gamepad"></i> Sala de Juego</button>`;
    
    if (state.user.rol === 'ADMIN') {
        menuHTML += `<button class="nav-item" onclick="showScreen('screen-admin')"><i class="fa-solid fa-screwdriver-wrench"></i> Admin Panel</button>`;
    }
    
    navMenu.innerHTML = menuHTML;
    
    // User badge
    userBadge.innerHTML = `
        <i class="fa-solid fa-user-circle"></i>
        <span class="username-display"><strong>${state.user.username}</strong></span>
        <button class="btn-logout" onclick="handleLogout()" title="Cerrar Sesión">
            <i class="fa-solid fa-right-from-bracket"></i>
        </button>
    `;
}

// --- AUTENTICACIÓN ---
function switchAuthTab(tab) {
    document.querySelectorAll(".auth-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
    
    if (tab === 'login') {
        document.querySelector("[onclick=\"switchAuthTab('login')\"]").classList.add("active");
        document.getElementById("form-login").classList.add("active");
    } else {
        document.querySelector("[onclick=\"switchAuthTab('register')\"]").classList.add("active");
        document.getElementById("form-register").classList.add("active");
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById("login-username").value;
    const pass = document.getElementById("login-password").value;
    
    try {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error en el inicio de sesión.");
        
        state.user = {
            token: data.token,
            username: data.username,
            rol: data.rol
        };
        
        localStorage.setItem("bingo_user", JSON.stringify(state.user));
        
        updateHeaderUI();
        initAppRouting();
        document.getElementById("form-login").reset();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const user = document.getElementById("register-username").value;
    const pass = document.getElementById("register-password").value;
    
    try {
        const res = await fetch(`${API_BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass, rol: "JUGADOR" })
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error en el registro.");
        
        showToast("¡Registro exitoso! Ya puedes iniciar sesión.", "success");
        switchAuthTab('login');
        document.getElementById("form-register").reset();
    } catch (err) {
        showToast(err.message, "error");
    }
}

function handleLogout() {
    state.user = null;
    localStorage.removeItem("bingo_user");
    updateHeaderUI();
    showScreen("screen-auth");
    switchAuthTab('login');
}

// --- POLLING EN SEGUNDO PLANO (Lobby global) ---
function startBackgroundPollers() {
    // Polling del lobby cada 5 segundos para actualizar el estado de la partida
    setInterval(() => {
        if (state.user) {
            fetchLobbyState();
        }
    }, 5000);
}

// --- LOBBY PRINCIPAL ---
async function fetchLobbyState() {
    if (!state.user) return;
    
    try {
        const res = await fetch(`${API_BASE}/api/game/active-partida`);
        const data = await res.json();
        
        const gameInfo = document.getElementById("lobby-game-info");
        const actionBox = document.getElementById("lobby-action-box");
        const statusBadge = document.getElementById("lobby-status-badge");
        
        state.activePartida = data.partida;
        
        if (!data.partida) {
            statusBadge.innerText = "Sin Partida";
            statusBadge.className = "card-badge";
            gameInfo.innerHTML = `<p class="info-empty">No hay partidas activas. Esperando que el Administrador inicie una sesión.</p>`;
            actionBox.style.display = "none";
            return;
        }
        
        const p = data.partida;
        
        if (p.estado === 'ACTIVA') {
            statusBadge.innerText = "Lobby de Ventas";
            statusBadge.className = "card-badge status-pagado";
            gameInfo.innerHTML = `
                <div class="text-center">
                    <h3>¡Partida #${p.id} está abierta!</h3>
                    <p class="mt-3">El administrador está recibiendo compras. Adquiere tu tabla antes de comenzar.</p>
                </div>
            `;
            actionBox.style.display = state.user.rol === 'JUGADOR' ? "block" : "none";
        } else if (p.estado === 'JUGANDO') {
            statusBadge.innerText = "Juego en Vivo";
            statusBadge.className = "card-badge status-reservado";
            gameInfo.innerHTML = `
                <div class="text-center">
                    <h3>Partida #${p.id} en curso</h3>
                    <p class="mt-3">Las ventas están cerradas. Las bolas se están extrayendo ahora mismo.</p>
                    <button class="btn btn-accent btn-md mt-4" onclick="showScreen('screen-game')">
                        <i class="fa-solid fa-gamepad"></i> Entrar a la Sala de Juego
                    </button>
                </div>
            `;
            actionBox.style.display = "none";
        } else {
            statusBadge.innerText = "Finalizada";
            statusBadge.className = "card-badge status-expirado";
            gameInfo.innerHTML = `<p class="info-empty">La última partida ha finalizado. El administrador creará otra pronto.</p>`;
            actionBox.style.display = "none";
        }
        
        // Cargar mis compras del lobby
        fetchMyLobbyTickets();
    } catch (err) {
        console.error("Error al obtener estado de lobby:", err);
    }
}

async function fetchMyLobbyTickets() {
    if (!state.user || !state.activePartida) return;
    
    try {
        const res = await fetch(`${API_BASE}/api/game/state`, {
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        
        const ticketsList = document.getElementById("lobby-tickets-list");
        
        if (!data.tickets || data.tickets.length === 0) {
            ticketsList.innerHTML = `<p class="info-empty">No has comprado ninguna tabla para esta partida.</p>`;
            return;
        }
        
        ticketsList.innerHTML = data.tickets.map(t => `
            <div class="ticket-item">
                <div>
                    <span class="ticket-id-tag"><i class="fa-solid fa-table"></i> Tabla #${t.tabla_id}</span>
                    <div class="ticket-code">Reserva: ${t.codigo_reserva}</div>
                </div>
                <div class="text-right">
                    <span class="ticket-status status-${t.estado.toLowerCase()}">${t.estado}</span>
                    ${t.estado === 'PAGADO' ? `
                        <button class="btn btn-secondary btn-sm mt-2" onclick="showScreen('screen-game')" style="display:block;">
                            Jugar <i class="fa-solid fa-circle-play"></i>
                        </button>
                    ` : `
                        <div class="ticket-code" style="font-size:0.7rem; color:#f59e0b; margin-top:0.25rem;">
                            Espera aprobación de pago.
                        </div>
                    `}
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error("Error al cargar compras:", err);
    }
}

// --- CATÁLOGO DE TABLAS ---
async function renderCatalogNumbers() {
    if (!state.user) return;
    
    const grid = document.getElementById("catalog-numbers-grid");
    if (!grid) return;
    
    let availableSet = new Set();
    try {
        // Cargar lista de tablas disponibles para la partida
        const res = await fetch(`${API_BASE}/api/tables/available`);
        if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.tables)) {
                availableSet = new Set(data.tables);
            }
        }
    } catch (err) {
        console.error("Error al obtener tablas disponibles:", err);
    }
    
    let html = '';
    // Mostramos las primeras 500 tablas estáticas
    // Si la API falla, por defecto se asume que están disponibles para no bloquear la interacción
    const fallbackAvailable = availableSet.size === 0;
    
    for (let i = 1; i <= 500; i++) {
        const isAvailable = fallbackAvailable ? true : availableSet.has(i);
        const classes = ['catalog-cell'];
        if (!isAvailable) classes.push('sold');
        if (state.selectedTableId === i) classes.push('selected');
        
        html += `
            <div class="${classes.join(' ')}" 
                 onclick="${isAvailable ? `selectCatalogTable(${i})` : ''}">
                #${i}
            </div>
        `;
    }
    grid.innerHTML = html;
}

function filterCatalogTable() {
    const val = parseInt(document.getElementById("catalog-search-id").value);
    const cells = document.querySelectorAll(".catalog-cell");
    
    cells.forEach((c, idx) => {
        const id = idx + 1;
        if (isNaN(val)) {
            c.style.display = "block";
        } else {
            c.style.display = id === val ? "block" : "none";
        }
    });
}

function selectSearchTable() {
    const val = parseInt(document.getElementById("catalog-search-id").value);
    if (val >= 1 && val <= 500) {
        selectCatalogTable(val);
    }
}

async function selectCatalogTable(id) {
    state.selectedTableId = id;
    
    // Resaltar en el grid
    document.querySelectorAll(".catalog-cell").forEach((c, idx) => {
        if (idx + 1 === id) c.classList.add("selected");
        else c.classList.remove("selected");
    });
    
    // Obtener detalles de la tabla (sus 4 cartones)
    const previewBox = document.getElementById("catalog-preview-box");
    previewBox.innerHTML = `
        <div class="text-center" style="margin-top:5rem;">
            <i class="fa-solid fa-circle-notch fa-spin" style="font-size:2rem; color:#6366f1;"></i>
            <p class="mt-3">Cargando cartones...</p>
        </div>
    `;
    
    try {
        // Consultar estado de partida en vivo antes de habilitar compra
        const partidaRes = await fetch(`${API_BASE}/api/game/active-partida`);
        const partidaData = await partidaRes.json();
        state.activePartida = partidaData.partida;
        
        const res = await fetch(`${API_BASE}/api/tables/${id}`);
        const data = await res.json();
        
        let cartonesHTML = '';
        data.cartones.forEach(c => {
            cartonesHTML += renderSingleCartonHTML(c, `Cartón VIP #${c.posicion}`);
        });
        
        const isSalesOpen = state.activePartida && state.activePartida.estado === 'ACTIVA';
        
        previewBox.innerHTML = `
            <div class="preview-header">
                <h3>Previsualización: Tabla #${id}</h3>
                ${isSalesOpen ? `
                    <button class="btn btn-accent btn-md" onclick="reserveSelectedTable(${id})">
                        <i class="fa-solid fa-cart-arrow-down"></i> Reservar Tabla
                    </button>
                ` : `
                    <div class="warning-tag" style="background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fca5a5; padding:0.5rem 1rem; border-radius:8px; font-size:0.9rem; font-weight:600;">
                        <i class="fa-solid fa-triangle-exclamation"></i> Ventas Cerradas (Sin Partida Activa en Lobby)
                    </div>
                `}
            </div>
            <div class="board-preview-container">
                ${cartonesHTML}
            </div>
        `;
        // Auto-scroll to preview on mobile
        if (window.innerWidth <= 900) {
            setTimeout(() => {
                previewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    } catch (err) {
        previewBox.innerHTML = `<p class="info-empty">Error al cargar la tabla: ${err.message}</p>`;
    }
}

async function reserveSelectedTable(id) {
    if (!confirm(`¿Deseas reservar la Tabla #${id} por 5 minutos?`)) return;
    
    try {
        const res = await fetch(`${API_BASE}/api/tickets/reserve`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.user.token}`
            },
            body: JSON.stringify({ tabla_id: id })
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "No se pudo realizar la reserva.");
        
        showToast(`¡Reserva realizada con éxito!\nHas reservado la Tabla #${data.tabla_id}.\nPor favor, indícale al Administrador tu número de Tabla para validar tu pago.`, "success");
        
        state.selectedTableId = null;
        showScreen("screen-lobby");
    } catch (err) {
        if (err.message && !err.message.includes("Sesión expirada")) {
            showToast(err.message, "error");
        }
    }
}

// RENDERIZADOR AUXILIAR DE CARTÓN BINGO
function renderSingleCartonHTML(carton, title, ticketId = null) {
    const letters = ['B', 'I', 'N', 'G', 'O'];
    let cellsHTML = '';
    
    // Renders de encabezado B-I-N-G-O
    letters.forEach(l => {
        cellsHTML += `<div class="carton-header-cell header-${l.toLowerCase()}">${l}</div>`;
    });
    
    // Renderizado 5x5 por filas
    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            const letter = letters[c];
            const val = carton[letter][r];
            
            if (r === 2 && c === 2) {
                // Free space
                cellsHTML += `<div class="carton-number-cell cell-free">FREE</div>`;
            } else {
                const uniqueCellKey = ticketId ? `${ticketId}_${carton.posicion}_${r}_${c}` : null;
                const isDaubedClass = (uniqueCellKey && state.daubedCells[uniqueCellKey]) ? 'daubed col-' + letter.toLowerCase() : '';
                
                cellsHTML += `
                    <div class="carton-number-cell col-cell-${letter.toLowerCase()} ${isDaubedClass}" 
                         id="${uniqueCellKey ? `cell-${uniqueCellKey}` : ''}"
                         data-val="${val}"
                         onclick="${ticketId ? `handleCellClick('${uniqueCellKey}', ${val}, '${letter.toLowerCase()}')` : ''}">
                        ${val}
                    </div>
                `;
            }
        }
    }
    
    return `
        <div class="carton-wrapper">
            <div class="carton-title">${title}</div>
            <div class="carton-grid">
                ${cellsHTML}
            </div>
        </div>
    `;
}

// --- RENDERIZADO DEL MINI-PATRÓN ---
function renderMiniPattern(objective, customPatternCoords) {
    let cellsHTML = '';
    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            let isActive = false;
            let isFree = (r === 2 && c === 2);
            
            if (objective === 'CARTÓN LLENO') {
                isActive = true;
            } else if (objective === 'CUALQUIER LÍNEA') {
                if (r === 2) isActive = true; // Línea horizontal representativa
            } else if (objective === 'PATRÓN PERSONALIZADO' && customPatternCoords) {
                const found = customPatternCoords.find(coord => coord[0] === r && coord[1] === c);
                if (found) isActive = true;
            }
            
            let classes = 'mini-cell';
            if (isActive && !isFree) classes += ' active';
            if (isFree) classes += ' free';
            
            cellsHTML += `<div class="${classes}"></div>`;
        }
    }
    return cellsHTML;
}

// --- SALA DE JUEGO EN VIVO ---
async function fetchGameState() {
    if (!state.user) return;
    
    try {
        const res = await fetch(`${API_BASE}/api/game/state`, {
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        
        state.gameState = data;
        
        if (!data.partida_id) {
            showScreen("screen-lobby");
            showToast("No hay juegos activos en este momento.", "warning");
            return;
        }

        // DETECCIÓN Y DISPARO DEL OVERLAY "CUENTA REGRESIVA" AL COMENZAR EL JUEGO
        if (data.estado === 'JUGANDO') {
            const countdownKey = `bingo_countdown_shown_${data.partida_id}`;
            if (!sessionStorage.getItem(countdownKey)) {
                sessionStorage.setItem(countdownKey, 'true');
                runGameStartCountdown();
            }
        }

        // DETECCIÓN Y DISPARO DEL OVERLAY "VENTAS CERRADAS"
        if (data.estado === 'JUGANDO') {
            const overlayKey = `bingo_lock_shown_${data.partida_id}`;
            if (!sessionStorage.getItem(overlayKey)) {
                sessionStorage.setItem(overlayKey, 'true');
                const overlay = document.getElementById("screen-lock-overlay");
                const progress = document.getElementById("lock-overlay-progress");
                if (overlay && progress) {
                    overlay.style.display = "flex";
                    progress.style.width = "0%";
                    // forzar reflow
                    overlay.offsetHeight;
                    progress.style.width = "100%";
                    setTimeout(() => {
                        overlay.style.opacity = "0";
                        overlay.style.transition = "opacity 500ms ease";
                        setTimeout(() => {
                            overlay.style.display = "none";
                            overlay.style.opacity = "1";
                        }, 500);
                    }, 3000);
                }
            }
        }

        // 1. Actualizar el bolillero en pantalla
        const balls = data.bolas_extraidas || [];
        const lastBall = balls.length > 0 ? balls[balls.length - 1] : null;

        const currentBallsListStr = balls.join(",");
        if (state.lastBallsListStr && state.lastBallsListStr !== currentBallsListStr && balls.length > (state.lastBallsCount || 0)) {
            playNewBallBeep(); // Nuevo sonido sutil para cada balota nueva
        }
        state.lastBallsListStr = currentBallsListStr;
        state.lastBallsCount = balls.length;
        
        const sphere = document.getElementById("game-ball-sphere");
        const bNum = document.getElementById("game-ball-number");
        const bLet = document.getElementById("game-ball-letter");
        
        if (lastBall) {
            const letter = getBingoLetter(lastBall);
            
            if (bNum.innerText !== String(lastBall)) {
                bNum.innerText = lastBall;
                bLet.innerText = letter;
                // Efecto de pulso en extracción
                sphere.className = "active-ball-sphere draw-pulse";
                setTimeout(() => sphere.className = "active-ball-sphere", 600);
            }
        } else {
            bNum.innerText = "-";
            bLet.innerText = "-";
        }
        
        // 1.5. Determinar Objetivo Actual y renderizar visualización
        let currentObjective = "Cargando...";
        let hasLineWinner = data.ganadores && data.ganadores.some(w => w.patron !== "Cartón Lleno" && w.patron !== "Patrón Personalizado");
        let hasFullWinner = data.ganadores && data.ganadores.some(w => w.patron === "Cartón Lleno");
        let hasCustomWinner = data.ganadores && data.ganadores.some(w => w.patron === "Patrón Personalizado");
        
        if (data.modalidad === 'LINEA_Y_CARTON_LLENO') {
            currentObjective = (hasLineWinner || hasFullWinner) ? 'CARTÓN LLENO' : 'CUALQUIER LÍNEA';
        } else if (data.modalidad === 'CUSTOM_Y_CARTON_LLENO') {
            currentObjective = (hasCustomWinner || hasFullWinner) ? 'CARTÓN LLENO' : 'PATRÓN PERSONALIZADO';
        } else if (data.modalidad === 'CARTON_LLENO') {
            currentObjective = 'CARTÓN LLENO';
        } else if (data.modalidad === 'LINEA') {
            currentObjective = 'CUALQUIER LÍNEA';
        } else if (data.modalidad === 'CUSTOM') {
            currentObjective = 'PATRÓN PERSONALIZADO';
        }

        const modBadge = document.getElementById("game-active-modalidad");
        if (modBadge) modBadge.innerText = currentObjective;

        const miniGrid = document.getElementById("objective-mini-grid");
        if (miniGrid) {
            miniGrid.innerHTML = renderMiniPattern(currentObjective, data.patron_custom);
        }

        const ballsCountText = document.getElementById("game-balls-count-text");
        if (ballsCountText && balls) {
            ballsCountText.innerText = `Bolitas extraídas: ${balls.length}/75`;
        }
        
        // 2. Historial de las 5 balotas recientes
        const recentBox = document.getElementById("game-recent-balls");
        const recentSlice = balls.slice(-6, -1).reverse(); // 5 anteriores a la última
        recentBox.innerHTML = recentSlice.map(b => `<div class="recent-ball">${b}</div>`).join('');
        
        // 3. Rellenar el Tablero de 75 Balotas general
        renderHallNumbers(balls);

        // 4. Renderizar mis cartones de juego
        const userTickets = data.tickets || [];
        const pagados = userTickets.filter(t => t.estado === 'PAGADO');
        const gridCartones = document.getElementById("game-cartones-grid");
        const titleTableId = document.getElementById("game-active-table-id");
        const ticketStatusTag = document.getElementById("game-ticket-status");
        const tabsContainer = document.getElementById("game-tables-tabs");
        const modalityTag = document.getElementById("game-active-modalidad");

        // Mostrar modalidad del juego
        if (modalityTag && data.modalidad) {
            let friendlyMod = "Línea y Cartón Lleno";
            if (data.modalidad === 'LINEA') friendlyMod = "Solo Línea";
            if (data.modalidad === 'CARTON_LLENO') friendlyMod = "Solo Cartón Lleno";
            if (data.modalidad === 'CUSTOM') friendlyMod = "Patrón Personalizado";
            modalityTag.innerText = friendlyMod;
        }
        
        // Auto-marcado en background para TODOS los tickets pagados
        if (state.autoDaub) {
            balls.forEach(b => {
                pagados.forEach(ticket => {
                    ticket.cartones.forEach(carton => {
                        const letters = ['B', 'I', 'N', 'G', 'O'];
                        for (let r = 0; r < 5; r++) {
                            for (let c = 0; c < 5; c++) {
                                const l = letters[c];
                                if (carton[l][r] === b) {
                                    // Filtro estricto para "Modalidad Sola"
                                    if (data.modalidad === 'CUSTOM' && data.patron_custom && Array.isArray(data.patron_custom)) {
                                        const isInPattern = data.patron_custom.some(coord => coord[0] === r && coord[1] === c);
                                        if (isInPattern) {
                                            state.daubedCells[`${ticket.ticket_id}_${carton.posicion}_${r}_${c}`] = true;
                                        }
                                    } else {
                                        state.daubedCells[`${ticket.ticket_id}_${carton.posicion}_${r}_${c}`] = true;
                                    }
                                }
                            }
                        }
                    });
                });
            });
        }

        if (pagados.length === 0) {
            titleTableId.innerText = "-";
            ticketStatusTag.className = "ticket-status-tag status-reservado";
            ticketStatusTag.innerText = "Sin Compra";
            if (tabsContainer) tabsContainer.style.display = "none";
            gridCartones.innerHTML = `
                <div class="glass-card text-center" style="grid-column: span 2; padding: 4rem;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:3rem; color:#f59e0b; margin-bottom:1rem;"></i>
                    <h3>No tienes tablas compradas (PAGADAS) para este juego.</h3>
                    <p class="mt-3">Visita el Lobby o el Catálogo para reservar y pídele al Admin que apruebe tu pago.</p>
                </div>
            `;
        } else {
            // Asegurar que activeGameTableId apunte a una de nuestras tablas pagadas
            const idsPagados = pagados.map(t => t.tabla_id);
            if (!state.activeGameTableId || !idsPagados.includes(state.activeGameTableId)) {
                state.activeGameTableId = pagados[0].tabla_id;
            }

            // Renderizar la barra de pestañas para cambiar de tabla
            if (tabsContainer) {
                if (pagados.length > 1) {
                    tabsContainer.style.display = "flex";
                    tabsContainer.innerHTML = pagados.map(t => {
                        const isActive = t.tabla_id === state.activeGameTableId;
                        return `
                            <button class="table-tab ${isActive ? 'active' : ''}" onclick="selectActiveGameTable(${t.tabla_id})">
                                <i class="fa-solid fa-table"></i> Tabla #${t.tabla_id}
                            </button>
                        `;
                    }).join('');
                } else {
                    tabsContainer.style.display = "none";
                }
            }

            // Mostrar el ticket activo (el de la tabla seleccionada)
            const activeTicket = pagados.find(t => t.tabla_id === state.activeGameTableId) || pagados[0];
            titleTableId.innerText = activeTicket.tabla_id;
            ticketStatusTag.className = "ticket-status-tag status-pagado";
            ticketStatusTag.innerText = "Jugando";

            let cartonesHTML = '';
            activeTicket.cartones.forEach(c => {
                cartonesHTML += renderSingleCartonHTML(c, `Cartón #${c.posicion}`, activeTicket.ticket_id);
            });
            gridCartones.innerHTML = cartonesHTML;
        }

        // 5. Monitorear si hay ganadores y desplegar el Popup WOW
        if (data.ganadores && data.ganadores.length > 0) {
            // Agrupar ganadores que aún no han sido anunciados en esta sesión de juego
            const newWinners = data.ganadores.filter(w => {
                const key = `${w.ticket_id}_${w.patron}`;
                return !state.announcedWinners.has(key);
            });

            if (newWinners.length > 0) {
                // Registrar a todos como anunciados para evitar molestos popups duplicados
                newWinners.forEach(w => {
                    state.announcedWinners.add(`${w.ticket_id}_${w.patron}`);
                });

                triggerPremiumWinnerOverlay(newWinners, data.modalidad, pagados);
            }
        }
    } catch (err) {
        console.error("Error al obtener estado del juego:", err);
    }
}

function selectActiveGameTable(id) {
    state.activeGameTableId = id;
    fetchGameState(); // Refrescar vista
}

function handleCellClick(key, val, letter) {
    if (state.autoDaub) return; // Si es auto-daub, cliquear no hace nada
    
    const element = document.getElementById(`cell-${key}`);
    
    // Validar si el número ya fue extraído en el bolillero real
    const drawnBalls = state.gameState.bolas_extraidas || [];
    if (!drawnBalls.includes(val)) {
        // No se puede marcar una casilla que no ha salido!
        element.style.animation = "shake 0.3s ease";
        setTimeout(() => element.style.animation = "", 300);
        return;
    }

    if (state.daubedCells[key]) {
        delete state.daubedCells[key];
        element.className = `carton-number-cell col-cell-${letter}`;
    } else {
        state.daubedCells[key] = true;
        element.className = `carton-number-cell col-cell-${letter} daubed col-${letter}`;
    }
}

function toggleAutoDaub() {
    state.autoDaub = document.getElementById("game-toggle-autodaub").checked;
    if (state.autoDaub) {
        // Al encender, refrescar instantáneamente para marcar todo
        fetchGameState();
    }
}

function checkCurrentBingoManual() {
    // Si el backend es quien valida, gritar BINGO simplemente actualiza y revisa en backend
    if (state.gameState && state.gameState.ganadores && state.gameState.ganadores.length > 0) {
        showToast("¡Hay un BINGO activo! Revisa la pantalla.", "warning");
    } else {
        showToast("El motor de premios no reporta ningún patrón completado aún en tus cartones. ¡Sigue atento al bolillero!", "info");
    }
}

function closeWinOverlay() {
    document.getElementById("bingo-win-overlay").classList.remove("active");
}

function playCountdownBeep(isFinal = false) {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (isFinal) {
            osc.type = 'square';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
            osc.start();
            osc.stop(ctx.currentTime + 0.6);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
            osc.start();
            osc.stop(ctx.currentTime + 0.2);
        }
    } catch (e) { console.warn("Audio ignorado"); }
}

function playNewBallBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            
            // Sonido percusivo de "bolita cayendo" (clack)
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.05);
            
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
            
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            osc.start();
            osc.stop(ctx.currentTime + 0.05);
            
            // Segundo impacto o "rebote"
            setTimeout(() => {
                if(ctx.state !== 'running') return;
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(500, ctx.currentTime);
                osc2.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.03);
                gain2.gain.setValueAtTime(0.15, ctx.currentTime);
                gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.03);
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.start();
                osc2.stop(ctx.currentTime + 0.03);
            }, 60);
        }
    } catch (e) { console.warn("Audio balota ignorado"); }
}

function runGameStartCountdown() {
    const overlay = document.getElementById("game-countdown-overlay");
    const numEl = document.getElementById("countdown-number");
    const textEl = document.getElementById("countdown-text");

    if (!overlay || !numEl || !textEl) return;

    overlay.style.display = "flex";
    setTimeout(() => {
        overlay.classList.add("active");
    }, 10);

    let count = 5;
    numEl.innerText = count;
    textEl.innerText = "PREPARANDO TABLAS...";

    const triggerPop = () => {
        numEl.style.transform = "scale(1.2)";
        playCountdownBeep(false);
        setTimeout(() => {
            numEl.style.transform = "scale(1)";
        }, 150);
    };

    triggerPop();

    const interval = setInterval(() => {
        count--;
        if (count > 0) {
            numEl.innerText = count;
            triggerPop();
        } else if (count === 0) {
            numEl.innerText = "¡SUERTE!";
            // Usar clamp para que no se salga de la pantalla en móviles
            numEl.style.fontSize = "clamp(2rem, 12vw, 4.5rem)";
            numEl.style.transform = "scale(1.1)";
            textEl.innerText = "¡QUE COMIENCE EL JUEGO!";
            playCountdownBeep(true);
        } else {
            clearInterval(interval);
            overlay.style.opacity = "0";
            overlay.style.transition = "opacity 450ms ease";
            setTimeout(() => {
                overlay.classList.remove("active");
                overlay.style.opacity = "";
                overlay.style.transition = "";
                numEl.style.fontSize = "";
                numEl.style.transform = "";
            }, 450);
        }
    }, 1000);
}

function triggerPremiumWinnerOverlay(newWinners, gameMod, pagados = []) {
    const overlay = document.getElementById("bingo-win-overlay");
    const titleEl = document.getElementById("win-overlay-title");
    const details = document.getElementById("win-overlay-details");
    const footerEl = document.getElementById("win-overlay-footer");

    if (!overlay || !titleEl || !details || !footerEl) return;

    const hasFullCarton = newWinners.some(w => w.patron === "Cartón Lleno");
    const hasCustom = newWinners.some(w => w.patron === "Patrón Personalizado");

    if (hasFullCarton) {
        titleEl.innerHTML = "¡BINGO DE CARTÓN LLENO!";
        footerEl.innerText = "¡Partida finalizada! Gracias por participar.";
    } else if (hasCustom) {
        titleEl.innerHTML = "¡BINGO DE PATRÓN LIBRE!";
        if (gameMod === 'CUSTOM_Y_CARTON_LLENO') {
            footerEl.innerText = "¡La partida continúa! Ahora jugamos por el Cartón Lleno.";
        } else {
            footerEl.innerText = "¡Partida finalizada! Gracias por participar.";
        }
    } else {
        titleEl.innerHTML = "¡TENEMOS GANADOR DE LÍNEA!";
        if (gameMod === 'LINEA_Y_CARTON_LLENO') {
            footerEl.innerText = "¡La partida continúa! Ahora jugamos por el Cartón Lleno.";
        } else {
            footerEl.innerText = "¡Partida finalizada! Gracias por participar.";
        }
    }

    let winnersHTML = '';
    newWinners.forEach(w => {
        winnersHTML += `
            <div class="winner-row" style="background: rgba(255, 255, 255, 0.04); border: 1px solid var(--glass-border); padding: 1rem; border-radius: 12px; margin-bottom: 0.75rem; text-align: left;">
                <div style="font-size: 1.15rem; font-weight: 700; color: #f472b6; margin-bottom: 0.25rem; display:flex; align-items:center; gap:0.5rem;">
                    <i class="fa-solid fa-user-astronaut" style="color:#fbbf24;"></i> ${w.username}
                </div>
                <div style="font-size: 0.95rem; color: #e5e7eb;">
                    Tabla de la Suerte: <span style="font-weight: 800; color:#38bdf8;">#${w.tabla_id}</span>
                </div>
                <div style="font-size: 0.9rem; color: #9ca3af; margin-top: 0.25rem;">
                    Completó: <strong style="color: #4ade80;">${w.patron}</strong> (Cartón #${w.carton_posicion})
                </div>
            </div>
        `;

        if (pagados.length > 0) {
            const ownedActiveTicket = pagados.find(t => t.tabla_id === w.tabla_id);
            if (ownedActiveTicket) {
                if (state.activeGameTableId !== w.tabla_id) {
                    selectActiveGameTable(w.tabla_id);
                }
                setTimeout(() => {
                    w.celdas.forEach(cell => {
                        const [r, c] = cell;
                        const element = document.getElementById(`cell-${ownedActiveTicket.ticket_id}_${w.carton_posicion}_${r}_${c}`);
                        if (element) {
                            element.classList.add("winning-cell");
                        }
                    });
                }, 500);
            }
        }
    });

    details.innerHTML = winnersHTML;
    overlay.classList.add("active");
}

function renderHallNumbers(drawnList) {
    const grid = document.getElementById("game-hall-numbers-grid");
    const drawnSet = new Set(drawnList);
    let html = '';
    
    // Renderear celdas de bolas 1 a 75
    for (let i = 1; i <= 75; i++) {
        const hasBeenDrawn = drawnSet.has(i);
        html += `
            <div class="hall-number-cell ${hasBeenDrawn ? 'drawn' : ''}">
                ${i}
            </div>
        `;
    }
    grid.innerHTML = html;
}

function getBingoLetter(num) {
    if (num >= 1 && num <= 15) return 'B';
    if (num >= 16 && num <= 30) return 'I';
    if (num >= 31 && num <= 45) return 'N';
    if (num >= 46 && num <= 60) return 'G';
    if (num >= 61 && num <= 75) return 'O';
    return '';
}

// --- DIBUJO DE PATRÓN PERSONALIZADO (ADMIN) ---
function toggleAdminCustomPatternGrid() {
    const mod = document.getElementById("admin-create-modalidad").value;
    const wrapper = document.getElementById("admin-custom-pattern-wrapper");
    if (mod === 'CUSTOM' || mod === 'CUSTOM_Y_CARTON_LLENO') {
        wrapper.style.display = "block";
        renderCustomPatternGrid();
    } else {
        wrapper.style.display = "none";
        customPatternSelectedCoords = [];
    }
}

function renderCustomPatternGrid() {
    const grid = document.getElementById("admin-custom-pattern-grid");
    if (!grid) return;
    
    let html = '';
    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            if (r === 2 && c === 2) {
                // Celda central libre
                html += `<div class="custom-pattern-cell free-cell">FREE</div>`;
            } else {
                const isActive = customPatternSelectedCoords.some(coord => coord[0] === r && coord[1] === c);
                html += `
                    <div class="custom-pattern-cell ${isActive ? 'active' : ''}" 
                         onclick="toggleCustomPatternCell(${r}, ${c}, this)">
                    </div>
                `;
            }
        }
    }
    grid.innerHTML = html;
}

function toggleCustomPatternCell(r, c, element) {
    const idx = customPatternSelectedCoords.findIndex(coord => coord[0] === r && coord[1] === c);
    if (idx > -1) {
        customPatternSelectedCoords.splice(idx, 1);
        element.classList.remove("active");
    } else {
        customPatternSelectedCoords.push([r, c]);
        element.classList.add("active");
    }
}

function clearCustomPatternGrid() {
    customPatternSelectedCoords = [];
    renderCustomPatternGrid();
}

// --- CONSOLA DE ADMINISTRADOR ---
async function fetchAdminState() {
    if (!state.user || state.user.rol !== 'ADMIN') return;
    
    try {
        const res = await fetch(`${API_BASE}/api/game/active-partida`);
        const data = await res.json();
        
        const statusTag = document.getElementById("admin-game-status");
        if (data.partida) {
            let friendlyMod = "Línea y Cartón Lleno";
            if (data.partida.modalidad === 'LINEA') friendlyMod = "Solo Línea";
            if (data.partida.modalidad === 'CARTON_LLENO') friendlyMod = "Solo Cartón Lleno";
            if (data.partida.modalidad === 'CUSTOM') friendlyMod = "Patrón Personalizado";
            statusTag.innerText = `Partida #${data.partida.id} (${data.partida.estado}) - ${friendlyMod}`;
            statusTag.className = "admin-state-tag status-pagado";
        } else {
            statusTag.innerText = "SIN PARTIDA";
            statusTag.className = "admin-state-tag status-expirado";
        }

        // Obtener estado del bolillero y ganadores en vivo para auditoría del admin
        const stateRes = await fetch(`${API_BASE}/api/game/state`, {
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const stateData = await stateRes.json();
        
        // Disparar Cuenta Regresiva de Inicio para el Administrador también
        if (stateData.estado === 'JUGANDO') {
            const countdownKey = `bingo_countdown_shown_${stateData.partida_id}`;
            if (!sessionStorage.getItem(countdownKey)) {
                sessionStorage.setItem(countdownKey, 'true');
                runGameStartCountdown();
            }
        }
        
        // Disparar Overlay de Ganador WOW para el Administrador
        if (stateData.ganadores && stateData.ganadores.length > 0) {
            const newWinners = stateData.ganadores.filter(w => {
                const key = `${w.ticket_id}_${w.patron}`;
                return !state.announcedWinners.has(key);
            });

            if (newWinners.length > 0) {
                newWinners.forEach(w => state.announcedWinners.add(`${w.ticket_id}_${w.patron}`));
                triggerPremiumWinnerOverlay(newWinners, stateData.modalidad);
            }
        }
        
        if (stateData.partida_id) {
            const balls = stateData.bolas_extraidas || [];
            const lastBall = balls.length > 0 ? balls[balls.length - 1] : null;
            
            const ballSphere = document.getElementById("admin-ball-sphere");
            if (ballSphere) {
                if (lastBall) {
                    ballSphere.innerText = `${getBingoLetter(lastBall)}${lastBall}`;
                    ballSphere.style.background = "var(--gradient-accent)";
                } else {
                    ballSphere.innerText = "-";
                    ballSphere.style.background = "var(--gradient-primary)";
                }
            }

            const drawnCount = document.getElementById("admin-drawn-count");
            if (drawnCount) {
                drawnCount.innerText = `Bolas extraídas: ${balls.length}/75`;
            }

            const winnersLog = document.getElementById("admin-winners-log");
            if (winnersLog) {
                if (stateData.ganadores && stateData.ganadores.length > 0) {
                    winnersLog.innerHTML = stateData.ganadores.map(g => {
                        const isLined = g.patron !== "Cartón Lleno" && g.patron !== "Patrón Personalizado";
                        const themeColor = isLined ? "#10b981" : "#f59e0b"; // Green for line, golden for full/custom
                        const themeBg = isLined ? "rgba(16,185,129,0.1)" : "rgba(245,158,11,0.1)";
                        const themeBorder = isLined ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.4)";
                        const trophyIcon = isLined ? "fa-award" : "fa-trophy";
                        
                        return `
                            <li style="border: 1px solid ${themeBorder}; border-left: 5px solid ${themeColor}; background: ${themeBg}; padding: 0.6rem 0.85rem; border-radius: 10px; display: flex; align-items: center; gap: 0.75rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15); margin-bottom: 0.5rem;">
                                <div style="font-size: 1.4rem; color: ${themeColor}; filter: drop-shadow(0 0 5px ${themeColor}); display: flex; align-items: center; justify-content: center;"><i class="fa-solid ${trophyIcon}"></i></div>
                                <div style="flex-grow: 1;">
                                    <div style="font-weight: 700; color: #fff; font-size: 0.9rem;">${g.username}</div>
                                    <div style="font-size: 0.75rem; color: #9ca3af; margin-top: 0.1rem;">
                                        Tabla <span style="color: ${themeColor}; font-weight: 800;">#${g.tabla_id}</span> (Cartón #${g.carton_posicion})
                                    </div>
                                </div>
                                <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 0.25rem 0.5rem; border-radius: 6px; font-size: 0.7rem; text-transform: uppercase; font-weight: 800; color: ${themeColor}; letter-spacing: 0.5px;">
                                    ${g.patron}
                                </div>
                            </li>
                        `;
                    }).join('');
                } else {
                    winnersLog.innerHTML = `<li style="color:#9ca3af; text-align:center; padding:0.5rem 0;">No hay ganadores registrados aún.</li>`;
                }
            }

            // Actualizar Histórico de Bolas Salidas en Orden Inverso (más reciente arriba/izquierda)
            const historyGrid = document.getElementById("admin-balls-history-grid");
            if (historyGrid) {
                if (balls.length > 0) {
                    historyGrid.innerHTML = [...balls].reverse().map(b => `
                        <div class="active-ball-sphere" style="width:36px; height:36px; font-size:0.8rem; font-weight:800; display:flex; align-items:center; justify-content:center; border-radius:50%; background:var(--gradient-primary); box-shadow:0 2px 6px rgba(99,102,241,0.3); border: 1px solid rgba(255,255,255,0.1);">
                            ${getBingoLetter(b)}${b}
                        </div>
                    `).join('');
                } else {
                    historyGrid.innerHTML = `<div style="color:#6b7280; text-align:center; padding:1rem 0; width:100%; font-size:0.8rem;">Ninguna bola extraída aún.</div>`;
                }
            }
            const historyCount = document.getElementById("admin-history-count");
            if (historyCount) {
                historyCount.innerText = `(${balls.length})`;
            }

        } else {
            const winnersLog = document.getElementById("admin-winners-log");
            if (winnersLog) {
                winnersLog.innerHTML = `<li style="color:#6b7280; text-align:center; padding:1rem 0;">Esperando que comience la partida...</li>`;
            }
            const historyGrid = document.getElementById("admin-balls-history-grid");
            if (historyGrid) {
                historyGrid.innerHTML = `<div style="color:#6b7280; text-align:center; padding:1rem 0; width:100%; font-size:0.8rem;">Ninguna bola extraída aún.</div>`;
            }
            const historyCount = document.getElementById("admin-history-count");
            if (historyCount) {
                historyCount.innerText = `(0)`;
            }
        }
    } catch (err) {
        console.error("Error al obtener estado admin:", err);
    }
}

async function fetchAdminSales() {
    if (!state.user || state.user.rol !== 'ADMIN') return;
    
    try {
        const res = await fetch(`${API_BASE}/api/admin/tickets/reservados`, {
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        
        const tbody = document.getElementById("admin-pending-tickets");
        if (tbody) {
            if (!data.tickets || data.tickets.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#9ca3af;">No hay reservas pendientes de pago en este momento.</td></tr>`;
            } else {
                tbody.innerHTML = data.tickets.map(t => {
                    const timeDiff = new Date(t.reservado_hasta) - new Date();
                    const min = Math.max(0, Math.floor(timeDiff / 1000 / 60));
                    
                    return `
                        <tr>
                            <td><strong>${t.username}</strong></td>
                            <td><span style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); color:#f87171; font-weight:800; font-size:1.1rem; padding:0.25rem 0.6rem; border-radius:6px; display:inline-block;">Tabla #${t.tabla_id}</span></td>
                            <td><span style="font-family:monospace; color:#9ca3af; font-size:0.9rem;">${t.codigo_reserva}</span></td>
                            <td>${min} min</td>
                            <td>
                                <button class="btn btn-success btn-sm" onclick="adminApproveTicket(${t.id})">
                                    <i class="fa-solid fa-check"></i> Aprobar Pago
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        console.error("Error al cargar ventas en admin:", err);
    }
}

async function fetchAdminAllTickets() {
    if (!state.user || state.user.rol !== 'ADMIN') return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/tickets/all`, {
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        
        // Renderizar estadísticas si existen
        if (data.stats) {
            const statDisp = document.getElementById("stat-disponibles");
            const statVend = document.getElementById("stat-vendidos");
            const statResv = document.getElementById("stat-reservados");
            if (statDisp) statDisp.innerText = data.stats.disponibles_count;
            if (statVend) statVend.innerText = data.stats.vendidos;
            if (statResv) statResv.innerText = data.stats.reservados;
            
            // Guardar disponibles en el estado para el modal
            state.tablasDisponibles = data.stats.disponibles_list || [];
        }

        const tbody = document.getElementById("admin-all-players-list");
        if (tbody) {
            if (!data.tickets || data.tickets.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#9ca3af;">No hay jugadores activos ni reservados en la partida.</td></tr>`;
            } else {
                tbody.innerHTML = data.tickets.map(t => {
                    const statusColor = t.estado === 'PAGADO' ? '#10b981' : '#f59e0b';
                    const statusBg = t.estado === 'PAGADO' ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)';
                    const statusBorder = t.estado === 'PAGADO' ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)';
                    return `
                        <tr>
                            <td><strong>${t.username}</strong></td>
                            <td><span style="background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.3); color:#818cf8; font-weight:800; padding:0.25rem 0.6rem; border-radius:6px;">Tabla #${t.tabla_id}</span></td>
                            <td><span style="background:${statusBg}; border:1px solid ${statusBorder}; color:${statusColor}; font-weight:700; font-size:0.85rem; padding:0.25rem 0.6rem; border-radius:6px;">${t.estado}</span></td>
                            <td><span style="font-family:monospace; color:#9ca3af; font-size:0.9rem;">${t.codigo_reserva}</span></td>
                            <td>
                                <button class="btn btn-danger btn-sm" onclick="adminDeleteTicket(${t.id}, '${t.estado}')" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                                    <i class="fa-solid ${t.estado === 'PAGADO' ? 'fa-rotate-left' : 'fa-xmark'}"></i> ${t.estado === 'PAGADO' ? 'Remover' : 'Rechazar'}
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        console.error("Error al cargar todos los tickets:", err);
    }
}

async function adminApproveTicket(ticketId) {
    try {
        const res = await fetch(`${API_BASE}/api/admin/tickets/${ticketId}/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "No se pudo aprobar el ticket.");
        
        showToast(data.message, "success");
        fetchAdminSales();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function adminDeleteTicket(ticketId, estado) {
    const actionName = estado === 'PAGADO' ? 'remover este pago aprobado' : 'rechazar esta reserva';
    if (!confirm(`¿Estás seguro que deseas ${actionName}? La tabla quedará libre nuevamente.`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/tickets/${ticketId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error al eliminar el ticket.");
        
        showToast(data.message, "success");
        fetchAdminSales();
        fetchAdminAllTickets();
    } catch (err) {
        showToast(err.message, "error");
    }
}

// LÓGICA DE TABS ADMIN
function switchAdminTab(tabName) {
    document.getElementById("btn-tab-bolillero").classList.remove("btn-primary");
    document.getElementById("btn-tab-bolillero").classList.add("btn-secondary");
    document.getElementById("btn-tab-ventas").classList.remove("btn-primary");
    document.getElementById("btn-tab-ventas").classList.add("btn-secondary");

    if (tabName === 'bolillero') {
        document.getElementById("btn-tab-bolillero").classList.add("btn-primary");
        document.getElementById("btn-tab-bolillero").classList.remove("btn-secondary");
        document.getElementById("admin-tab-bolillero").style.display = "grid";
        document.getElementById("admin-tab-ventas").style.display = "none";
    } else {
        document.getElementById("btn-tab-ventas").classList.add("btn-primary");
        document.getElementById("btn-tab-ventas").classList.remove("btn-secondary");
        document.getElementById("admin-tab-bolillero").style.display = "none";
        document.getElementById("admin-tab-ventas").style.display = "flex";
    }
}

// MODAL DE TABLAS DISPONIBLES
function showDisponiblesModal() {
    const container = document.getElementById("disponibles-list-container");
    if (!container) return;
    
    if (!state.tablasDisponibles || state.tablasDisponibles.length === 0) {
        container.innerHTML = `<p style="color:#9ca3af; width:100%; text-align:center;">No hay tablas disponibles. ¡Todo vendido!</p>`;
    } else {
        container.innerHTML = state.tablasDisponibles.map(num => `
            <div style="background: rgba(168,85,247,0.15); border: 1px solid rgba(168,85,247,0.3); color: #c084fc; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 800;">
                #${num}
            </div>
        `).join('');
    }
    
    document.getElementById("disponibles-overlay").style.display = "flex";
    setTimeout(() => { document.getElementById("disponibles-overlay").classList.add("active"); }, 10);
}

function closeDisponiblesModal() {
    const overlay = document.getElementById("disponibles-overlay");
    if (overlay) {
        overlay.classList.remove("active");
        setTimeout(() => { overlay.style.display = "none"; }, 400);
    }
}


async function adminCreateGame() {
    try {
        const mod = document.getElementById("admin-create-modalidad").value;
        const keepTickets = document.getElementById("admin-keep-tickets").checked;
        const res = await fetch(`${API_BASE}/api/admin/partida/create`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.user.token}` 
            },
            body: JSON.stringify({ 
                modalidad: mod,
                patron_custom: (mod === 'CUSTOM' || mod === 'CUSTOM_Y_CARTON_LLENO') ? customPatternSelectedCoords : null,
                keep_tickets: keepTickets
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error al crear partida.");
        
        showToast(data.message, "success");
        
        // Limpiar el dibujo del patrón custom tras crear
        if (mod === 'CUSTOM' || mod === 'CUSTOM_Y_CARTON_LLENO') {
            clearCustomPatternGrid();
        }
        
        fetchAdminState();
        fetchAdminSales();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function adminStartGame() {
    try {
        const res = await fetch(`${API_BASE}/api/admin/partida/start`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error al iniciar partida.");
        
        showToast(data.message, "success");
        fetchAdminState();
    } catch (err) {
        showToast(err.message, "error");
    }
}

let autoDrawInterval = null;

function toggleAutoDraw() {
    const btn = document.getElementById("btn-auto-draw");
    const manualBtn = document.getElementById("btn-manual-draw");
    if (autoDrawInterval) {
        clearInterval(autoDrawInterval);
        autoDrawInterval = null;
        if(btn) btn.innerHTML = '<i class="fa-solid fa-robot"></i> Iniciar Modo Auto (5s)';
        if(btn) btn.style.background = 'var(--gradient-accent)';
        if(manualBtn) manualBtn.disabled = false;
        showToast("Modo Automático Detenido", "info");
    } else {
        autoDrawInterval = setInterval(() => {
            adminDrawBall();
        }, 5500); // 5.5s para dar tiempo a efectos y peticiones
        if(btn) btn.innerHTML = '<i class="fa-solid fa-stop-circle"></i> Detener Modo Auto';
        if(btn) btn.style.background = 'var(--gradient-danger)';
        if(manualBtn) manualBtn.disabled = true;
        showToast("Modo Automático Iniciado", "success");
        adminDrawBall(); // Sacar la primera inmediatamente
    }
}

async function adminDrawBall() {
    try {
        const res = await fetch(`${API_BASE}/api/admin/partida/draw`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.user.token}` 
            },
            body: JSON.stringify({ mode: "LINEA" })
        });
        
        const data = await res.json();
        if (!res.ok) {
            if (autoDrawInterval) toggleAutoDraw(); // Detener auto-draw en caso de error (juego finalizado, saturado, etc)
            throw new Error(data.detail || "Error al extraer bola.");
        }
        
        // Notificación flotante elegante auto-cerrable con el número extraído
        showToast(`Bolita Extraída: ${getBingoLetter(data.bola)} - ${data.bola} (Bola #${data.orden})`, "success");
        
        if (data.ganadores && data.ganadores.length > 0) {
            if (autoDrawInterval) {
                toggleAutoDraw(); // Pausar automático para que el admin confirme/vea el ganador
            }
            const winnersListStr = data.ganadores.map(g => `${g.username} (#${g.tabla_id})`).join(', ');
            showToast(`¡¡¡TENEMOS GANADOR!!! ${winnersListStr} cantó BINGO!`, "warning");
        }
        
        fetchAdminState();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function adminEndGame() {
    if (!confirm("¿Deseas finalizar oficialmente la partida? Las celdas y bolilleros se detendrán.")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/partida/end`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error al finalizar juego.");
        
        showToast(data.message, "success");
        fetchAdminState();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function adminResetAllData() {
    if (!confirm("¡ALERTA DE SISTEMA! Esto borrará permanentemente todo el historial de partidas, reservas, ventas y bolillas.\nEl catálogo maestro de 500 tablas NO será afectado.\n¿Proceder con la limpieza completa?")) return;
    try {
        const res = await fetch(`${API_BASE}/api/admin/partida/reset-all`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${state.user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Error al resetear.");
        
        showToast(data.message, "success");
        fetchAdminState();
        fetchAdminSales();
    } catch (err) {
        showToast(err.message, "error");
    }
}
