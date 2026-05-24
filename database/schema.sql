-- Esquema DDL para el Bingo Digital de 75 Bolas

-- 1. Tabla de Usuarios
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK(rol IN ('JUGADOR', 'ADMIN')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Catálogo Maestro Estático de Tablas y Cartones
CREATE TABLE IF NOT EXISTS tablas_maestras (
    id INTEGER PRIMARY KEY, -- ID estático de 1 a 500
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cartones_maestros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tabla_id INTEGER NOT NULL,
    posicion INTEGER NOT NULL CHECK(posicion BETWEEN 1 AND 4), -- 4 cartones por tabla
    b_column TEXT NOT NULL, -- JSON array de 5 números (1-15)
    i_column TEXT NOT NULL, -- JSON array de 5 números (16-30)
    n_column TEXT NOT NULL, -- JSON array de 5 números (31-45), centro es 0 (FREE)
    g_column TEXT NOT NULL, -- JSON array de 5 números (46-60)
    o_column TEXT NOT NULL, -- JSON array de 5 números (61-75)
    hash TEXT NOT NULL UNIQUE, -- SHA-256 único de este cartón para validación rápida
    FOREIGN KEY(tabla_id) REFERENCES tablas_maestras(id) ON DELETE CASCADE
);

-- Índices para búsquedas ultra-rápidas en el catálogo maestro
CREATE INDEX IF NOT EXISTS idx_cartones_tabla ON cartones_maestros(tabla_id);
CREATE INDEX IF NOT EXISTS idx_cartones_hash ON cartones_maestros(hash);

-- 3. Transacciones y Lógica de Partidas
CREATE TABLE IF NOT EXISTS partidas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estado TEXT NOT NULL CHECK(estado IN ('CREADA', 'ACTIVA', 'JUGANDO', 'FINALIZADA')),
    modalidad TEXT NOT NULL CHECK(modalidad IN ('LINEA', 'CARTON_LLENO', 'LINEA_Y_CARTON_LLENO', 'CUSTOM', 'CUSTOM_Y_CARTON_LLENO')) DEFAULT 'LINEA_Y_CARTON_LLENO',
    patron_custom TEXT, -- JSON array de celdas ganadoras [[r, c], ...] para modo CUSTOM
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets_venta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partida_id INTEGER NOT NULL,
    tabla_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    codigo_reserva TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL CHECK(estado IN ('RESERVADO', 'PAGADO', 'EXPIRADO')),
    reservado_hasta TIMESTAMP NOT NULL, -- Control de concurrencia (lockout temporal de la tabla)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(partida_id) REFERENCES partidas(id) ON DELETE CASCADE,
    FOREIGN KEY(tabla_id) REFERENCES tablas_maestras(id),
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
);

-- Índices para optimizar las consultas de disponibilidad y tickets activos en una partida
CREATE INDEX IF NOT EXISTS idx_tickets_partida ON tickets_venta(partida_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tabla_partida ON tickets_venta(tabla_id, partida_id);
CREATE INDEX IF NOT EXISTS idx_tickets_usuario ON tickets_venta(usuario_id);

-- 4. Bolillero e Historial de Extracción
CREATE TABLE IF NOT EXISTS historial_bolillero (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partida_id INTEGER NOT NULL,
    bola_extraida INTEGER NOT NULL CHECK(bola_extraida BETWEEN 1 AND 75),
    orden_extraccion INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(partida_id) REFERENCES partidas(id) ON DELETE CASCADE,
    UNIQUE(partida_id, bola_extraida) -- No se puede repetir una bola en la misma partida
);

CREATE INDEX IF NOT EXISTS idx_bolillero_partida ON historial_bolillero(partida_id);
