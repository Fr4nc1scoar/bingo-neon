-- PostgreSQL Schema DDL para el Bingo Digital de 75 Bolas

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK(rol IN ('JUGADOR', 'ADMIN')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tablas_maestras (
    id INTEGER PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cartones_maestros (
    id SERIAL PRIMARY KEY,
    tabla_id INTEGER NOT NULL,
    posicion INTEGER NOT NULL CHECK(posicion BETWEEN 1 AND 4),
    b_column TEXT NOT NULL,
    i_column TEXT NOT NULL,
    n_column TEXT NOT NULL,
    g_column TEXT NOT NULL,
    o_column TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    FOREIGN KEY(tabla_id) REFERENCES tablas_maestras(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cartones_tabla ON cartones_maestros(tabla_id);
CREATE INDEX IF NOT EXISTS idx_cartones_hash ON cartones_maestros(hash);

CREATE TABLE IF NOT EXISTS partidas (
    id SERIAL PRIMARY KEY,
    estado TEXT NOT NULL CHECK(estado IN ('CREADA', 'ACTIVA', 'JUGANDO', 'FINALIZADA')),
    modalidad TEXT NOT NULL CHECK(modalidad IN ('LINEA', 'CARTON_LLENO', 'LINEA_Y_CARTON_LLENO', 'CUSTOM', 'CUSTOM_Y_CARTON_LLENO')) DEFAULT 'LINEA_Y_CARTON_LLENO',
    patron_custom TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets_venta (
    id SERIAL PRIMARY KEY,
    partida_id INTEGER NOT NULL,
    tabla_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    codigo_reserva TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL CHECK(estado IN ('RESERVADO', 'PAGADO', 'EXPIRADO')),
    reservado_hasta TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(partida_id) REFERENCES partidas(id) ON DELETE CASCADE,
    FOREIGN KEY(tabla_id) REFERENCES tablas_maestras(id),
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_partida ON tickets_venta(partida_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tabla_partida ON tickets_venta(tabla_id, partida_id);
CREATE INDEX IF NOT EXISTS idx_tickets_usuario ON tickets_venta(usuario_id);

CREATE TABLE IF NOT EXISTS historial_bolillero (
    id SERIAL PRIMARY KEY,
    partida_id INTEGER NOT NULL,
    bola_extraida INTEGER NOT NULL CHECK(bola_extraida BETWEEN 1 AND 75),
    orden_extraccion INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(partida_id) REFERENCES partidas(id) ON DELETE CASCADE,
    UNIQUE(partida_id, bola_extraida)
);

CREATE INDEX IF NOT EXISTS idx_bolillero_partida ON historial_bolillero(partida_id);
