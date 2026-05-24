// ==========================================================================
// BINGO DIGITAL PREMIUM - LÓGICA FRONTEND SPA (REAL-TIME POLLING)
// ==========================================================================

const API_BASE = window.location.origin;

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
        // Polling de alta frecuencia para juego en vivo (cada 1.5s)
        if (!state.pollerInterval) {
            state.pollerInterval = setInterval(fetchGameState, 1500);
        }
    } else if (screenId === 'screen-admin') {
        fetchAdminSales();
        fetchAdminState();
        if (!state.adminPollerInterval) {
            state.adminPollerInterval = setInterval(() => {
                fetchAdminSales();
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
    const user = document.getElementById("reg-username").value;
    const pass = document.getElementById("reg-password").value;
    
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
    
    try {
        // Cargar lista de tablas disponibles para la partida
        const res = await fetch(`${API_BASE}/api/tables/available`);
        const data = await res.json();
        const availableSet = new Set(data.tables);
        
        const grid = document.getElementById("catalog-numbers-grid");
        let html = '';
        
        // Mostramos las primeras 500 tablas estáticas
        for (let i = 1; i <= 500; i++) {
            const isAvailable = availableSet.has(i);
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
    } catch (err) {
        console.error("Error al renderizar catálogo:", err);
    }
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
        
        alert(`¡Reserva realizada con éxito!\nHas reservado la Tabla #${data.tabla_id}.\nPor favor, indícale al Administrador tu número de Tabla (#${data.tabla_id}) para registrar y validar tu pago.`);
        
        state.selectedTableId = null;
        showScreen("screen-lobby");
    } catch (err) {
        alert(err.message);
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
                                    state.daubedCells[`${ticket.ticket_id}_${carton.posicion}_${r}_${c}`] = true;
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
            const firstWinner = data.ganadores[0];
            const winnerKey = `${firstWinner.ticket_id}_${firstWinner.patron}`;
            
            if (!state.announcedWinners.has(winnerKey)) {
                state.announcedWinners.add(winnerKey);
                
                // Mostrar overlay
                const overlay = document.getElementById("bingo-win-overlay");
                const details = document.getElementById("win-overlay-details");
                
                details.innerHTML = `
                    <p style="font-size:1.2rem; margin-bottom:1rem;">
                        ¡El jugador <strong>${firstWinner.username}</strong> ha cantado BINGO!
                    </p>
                    <div style="background:rgba(255,255,255,0.03); border:1px solid var(--glass-border); padding:1rem; border-radius:8px;">
                        <div>Tabla de la Suerte: <strong>#${firstWinner.tabla_id}</strong></div>
                        <div>Patrón Completado: <strong>${firstWinner.patron}</strong></div>
                        <div style="font-size:0.9rem; color:#9ca3af; margin-top:0.5rem;">
                            Cartón #${firstWinner.carton_posicion} de su set.
                        </div>
                    </div>
                `;
                overlay.classList.add("active");
                
                // Resaltar celdas ganadoras en el cartón si es del usuario (cualquiera de sus tablas)
                const ownedActiveTicket = pagados.find(t => t.tabla_id === firstWinner.tabla_id);
                if (ownedActiveTicket) {
                    if (state.activeGameTableId !== firstWinner.tabla_id) {
                        selectActiveGameTable(firstWinner.tabla_id);
                    }
                    // Animación de victoria en sus celdas
                    setTimeout(() => {
                        firstWinner.celdas.forEach(cell => {
                            const [r, c] = cell;
                            const element = document.getElementById(`cell-${ownedActiveTicket.ticket_id}_${firstWinner.carton_posicion}_${r}_${c}`);
                            if (element) {
                                element.classList.add("winning-cell");
                            }
                        });
                    }, 500);
                }
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
        alert("¡Hay un BINGO activo! Revisa la pantalla.");
    } else {
        alert("El motor de premios no reporta ningún patrón completado aún en tus cartones. ¡Sigue atento al bolillero!");
    }
}

function closeWinOverlay() {
    document.getElementById("bingo-win-overlay").classList.remove("active");
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
                    winnersLog.innerHTML = stateData.ganadores.map(g => `
                        <li style="border-left: 3px solid #10b981; padding-left: 0.5rem; background: rgba(16,185,129,0.05); padding: 0.25rem 0.5rem; border-radius: 4px;">
                            <span style="color:#34d399; font-weight:700;">¡BINGO!</span> 
                            <strong>${g.username}</strong> con Tabla <strong>#${g.tabla_id}</strong> (Cartón #${g.carton_posicion}) - <em>${g.patron}</em>
                        </li>
                    `).join('');
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
        
        if (!data.tickets || data.tickets.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#9ca3af;">No hay reservas pendientes de pago en este momento.</td></tr>`;
            return;
        }
        
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
    } catch (err) {
        console.error("Error al cargar ventas en admin:", err);
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
        if (!res.ok) throw new Error(data.detail || "Error al extraer bola.");
        
        // Notificación flotante elegante auto-cerrable con el número extraído
        showToast(`Balota Extraída: ${getBingoLetter(data.bola)} - ${data.bola} (Bola #${data.orden_extraccion})`, "success");
        
        if (data.ganadores && data.ganadores.length > 0) {
            showToast(`¡¡¡TENEMOS GANADOR!!! El jugador ${data.ganadores[0].username} cantó BINGO con la Tabla #${data.ganadores[0].tabla_id}!`, "warning");
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
