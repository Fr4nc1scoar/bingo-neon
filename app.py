import os
import random
import hashlib
import json
import sqlite3
import psycopg2
import psycopg2.extras
import uuid
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException, Depends, Header, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.generator import generate_master_catalog
from core.validator import check_table_win

# Inicializar FastAPI
app = FastAPI(title="Bingo Digital Premium API", version="1.0.0")

# Habilitar CORS y Compresión GZIP
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.environ.get('DATABASE_URL')
DB_PATH = os.environ.get('DB_PATH', 'bingo.db')

# --- CACHE EN MEMORIA ---
GANADORES_CACHE = {}
CARTONES_CACHE = {}

# --- DB CONNECTION POOL FOR POSTGRES (PRODUCTION) ---
pg_pool = None
if DATABASE_URL:
    try:
        from psycopg2.pool import ThreadedConnectionPool
        # Connection pool with 2 to 40 reusable connections
        pg_pool = ThreadedConnectionPool(2, 40, dsn=DATABASE_URL)
        print("Pool de conexiones PostgreSQL (2 a 40) inicializado con éxito.")
    except Exception as e:
        print(f"Error al inicializar el pool de conexiones: {e}")

# --- DB ABSTRACTION WRAPPER PARA POSTGRES ---
class PostgresCursorWrapper:
    def __init__(self, pg_cursor):
        self.pg_cursor = pg_cursor
        
    def execute(self, query, params=None):
        query = query.replace('?', '%s')
        if params is None:
            self.pg_cursor.execute(query)
        else:
            self.pg_cursor.execute(query, params)
        return self

    def fetchone(self):
        return self.pg_cursor.fetchone()

    def fetchall(self):
        return self.pg_cursor.fetchall()
        
    def executescript(self, script):
        self.pg_cursor.execute(script)

class PostgresConnWrapper:
    def __init__(self, pg_conn):
        self.pg_conn = pg_conn
        
    def cursor(self):
        return PostgresCursorWrapper(self.pg_conn.cursor(cursor_factory=psycopg2.extras.DictCursor))
        
    def commit(self):
        self.pg_conn.commit()
        
    def close(self):
        # En el caso de pool, no cerramos la conexión física, pero este wrapper
        # puede llamarse de todas formas. Hacemos pass ya que putconn lo maneja.
        pass

# --- LÓGICA DE BASE DE DATOS (Manejador de Conexiones) ---
def get_db():
    if DATABASE_URL and pg_pool:
        conn = None
        try:
            conn = pg_pool.getconn()
        except Exception as e:
            print(f"Error al obtener conexión del pool: {e}")
            raise HTTPException(status_code=500, detail="Base de datos saturada, por favor intenta de nuevo.")
            
        try:
            wrapped = PostgresConnWrapper(conn)
            yield wrapped
        finally:
            if conn:
                try:
                    conn.rollback() # Prevenir InFailedSqlTransaction limpiando el estado
                except:
                    pass
                pg_pool.putconn(conn)
    else:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Habilitar claves foráneas
        conn.execute("PRAGMA foreign_keys = ON;")
        try:
            yield conn
        finally:
            conn.close()

def init_db():
    """Inicializa la base de datos aplicando el archivo schema.sql si las tablas no existen."""
    if DATABASE_URL:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()
        schema_path = os.path.join(os.path.dirname(__file__), 'database', 'schema_pg.sql')
        if os.path.exists(schema_path):
            with open(schema_path, 'r', encoding='utf-8') as f:
                cursor.execute(f.read())
            conn.commit()
            
        try:
            cursor.execute("ALTER TABLE partidas ADD COLUMN modalidad TEXT DEFAULT 'LINEA_Y_CARTON_LLENO';")
            conn.commit()
        except psycopg2.errors.DuplicateColumn:
            conn.rollback()
        except psycopg2.Error:
            conn.rollback()

        try:
            cursor.execute("ALTER TABLE partidas ADD COLUMN patron_custom TEXT;")
            conn.commit()
            print("Migración: Columna 'patron_custom' agregada exitosamente a la tabla 'partidas'.")
        except psycopg2.errors.DuplicateColumn:
            conn.rollback()
        except psycopg2.Error:
            conn.rollback()
            
        cursor.execute("SELECT COUNT(*) FROM tablas_maestras;")
        count = cursor.fetchone()[0]
        if count < 500:
            print(f"Catálogo maestro vacío o incompleto ({count}/500). Generando 500 tablas estáticas...")
            wrapped_conn = PostgresConnWrapper(conn)
            generate_master_catalog(wrapped_conn.cursor(), conn, 500)
            print("¡Catálogo maestro inicializado con éxito!")
        conn.close()
    else:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        schema_path = os.path.join(os.path.dirname(__file__), 'database', 'schema.sql')
        
        if os.path.exists(schema_path):
            with open(schema_path, 'r', encoding='utf-8') as f:
                cursor.executescript(f.read())
            conn.commit()
        
        try:
            cursor.execute("ALTER TABLE partidas ADD COLUMN modalidad TEXT DEFAULT 'LINEA_Y_CARTON_LLENO';")
            conn.commit()
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE partidas ADD COLUMN patron_custom TEXT;")
            conn.commit()
            print("Migración: Columna 'patron_custom' agregada exitosamente a la tabla 'partidas'.")
        except sqlite3.OperationalError:
            pass
            
        cursor.execute("SELECT COUNT(*) FROM tablas_maestras;")
        count = cursor.fetchone()[0]
        if count < 500:
            print(f"Catálogo maestro vacío o incompleto ({count}/500). Generando 500 tablas estáticas...")
            generate_master_catalog(cursor, conn, 500)
            print("¡Catálogo maestro inicializado con éxito!")
        conn.close()
    
# --- SEGURIDAD Y TOKEN MOCK (Ligero y sin dependencias externas complejas) ---
# En producción usaríamos JWT, para este prototipo premium local usaremos tokens opacos simples.
# Guardamos los tokens en memoria (se limpian si el servidor se reinicia, lo cual es excelente para pruebas)
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}

def get_current_user(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token de autorización faltante o inválido.")
    token = authorization.split(" ")[1]
    if token not in ACTIVE_SESSIONS:
        raise HTTPException(status_code=401, detail="Sesión expirada o token no válido.")
    return ACTIVE_SESSIONS[token]

def get_admin_user(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    if current_user['rol'] != 'ADMIN':
        raise HTTPException(status_code=403, detail="Permisos insuficientes. Solo administradores.")
    return current_user

def hash_password(password: str) -> str:
    salt = "bingo_secret_salt_2026"
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000).hex()

# --- MODELOS DE ENTRADA (Pydantic) ---
class UserRegister(BaseModel):
    username: str
    password: str
    rol: str = "JUGADOR" # JUGADOR o ADMIN

class UserLogin(BaseModel):
    username: str
    password: str

class TableReserve(BaseModel):
    tabla_id: int

class DrawConfig(BaseModel):
    mode: str = "LINEA" # LINEA o CARTON_LLENO

class PartidaCreate(BaseModel):
    modalidad: str = "LINEA_Y_CARTON_LLENO" # LINEA, CARTON_LLENO, LINEA_Y_CARTON_LLENO, CUSTOM, CUSTOM_Y_CARTON_LLENO
    patron_custom: Optional[List[List[int]]] = None
    keep_tickets: bool = False

# --- ENDPOINTS DE AUTENTICACIÓN ---

@app.post("/api/auth/register")
def register(data: UserRegister, db: sqlite3.Connection = Depends(get_db)):
    # Por motivos de seguridad extrema, todo registro público es forzado al rol de JUGADOR.
    # El rol ADMIN solo puede existir a través de semillas internas en la base de datos.
    rol_forced = "JUGADOR"
    
    username_clean = data.username.strip()
    if len(username_clean) < 3:
        raise HTTPException(status_code=400, detail="El usuario debe tener al menos 3 caracteres.")
        
    p_hash = hash_password(data.password)
    
    cursor = db.cursor()
    try:
        # Check if username already exists case-insensitively
        cursor.execute("SELECT id FROM usuarios WHERE LOWER(username) = LOWER(?)", (username_clean,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="El nombre de usuario ya está registrado.")
            
        cursor.execute(
            "INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?);",
            (username_clean, p_hash, rol_forced)
        )
        db.commit()
    except (sqlite3.IntegrityError, psycopg2.errors.UniqueViolation):
        if DATABASE_URL:
            db.pg_conn.rollback()
        raise HTTPException(status_code=400, detail="El nombre de usuario ya está registrado.")
        
    return {"message": "Usuario registrado con éxito."}

@app.post("/api/auth/login")
def login(data: UserLogin, db: sqlite3.Connection = Depends(get_db)):
    p_hash = hash_password(data.password)
    cursor = db.cursor()
    cursor.execute(
        "SELECT id, username, rol FROM usuarios WHERE username = ? AND password_hash = ?;",
        (data.username.strip(), p_hash)
    )
    user = cursor.fetchone()
    if not user:
        raise HTTPException(status_code=400, detail="Credenciales incorrectas.")
        
    # Crear sesión opaca única
    token = hashlib.sha256(f"{user['id']}-{user['username']}-{random.random()}".encode()).hexdigest()
    session_data = {
        "id": user['id'],
        "username": user['username'],
        "rol": user['rol']
    }
    ACTIVE_SESSIONS[token] = session_data
    
    return {
        "token": token,
        "username": user['username'],
        "rol": user['rol'],
        "message": "Inicio de sesión exitoso."
    }

# --- ENDPOINTS DE JUEGO Y CATÁLOGO ---

@app.get("/api/game/active-partida")
def get_active_partida(db: sqlite3.Connection = Depends(get_db)):
    """Obtiene la partida activa/creada. Si no existe, devuelve nulo."""
    cursor = db.cursor()
    cursor.execute(
        "SELECT id, estado, modalidad, created_at FROM partidas WHERE estado IN ('CREADA', 'ACTIVA', 'JUGANDO') ORDER BY id DESC LIMIT 1;"
    )
    partida = cursor.fetchone()
    if not partida:
        return {"partida": None}
    return {"partida": dict(partida)}

@app.get("/api/tables/available")
def get_available_tables(db: sqlite3.Connection = Depends(get_db)):
    """Lista las tablas maestras que están libres para la partida activa actual."""
    cursor = db.cursor()
    
    # Obtener partida activa
    cursor.execute("SELECT id FROM partidas WHERE estado IN ('ACTIVA', 'JUGANDO') ORDER BY id DESC LIMIT 1;")
    active_partida = cursor.fetchone()
    
    if not active_partida:
        # Si no hay partida, todas las 500 tablas se listan libres por defecto
        cursor.execute("SELECT id FROM tablas_maestras ORDER BY id ASC;")
        tables = cursor.fetchall()
        return {"tables": [t['id'] for t in tables]}
        
    partida_id = active_partida['id']
    
    # Buscar tablas ocupadas (únicamente las que ya están pagadas)
    cursor.execute("""
        SELECT tm.id FROM tablas_maestras tm
        WHERE tm.id NOT IN (
            SELECT tv.tabla_id FROM tickets_venta tv
            WHERE tv.partida_id = ? AND tv.estado = 'PAGADO'
        )
        ORDER BY tm.id ASC;
    """, (partida_id,))
    
    tables = cursor.fetchall()
    return {"tables": [t['id'] for t in tables]}

@app.get("/api/tables/{tabla_id}")
def get_table_details(tabla_id: int, db: sqlite3.Connection = Depends(get_db)):
    """Obtiene los 4 cartones detallados de una tabla maestra por su ID."""
    cursor = db.cursor()
    cursor.execute("SELECT id FROM tablas_maestras WHERE id = ?;", (tabla_id,))
    if not cursor.fetchone():
        raise HTTPException(status_code=404, detail="Tabla no encontrada en el catálogo maestro.")
        
    cursor.execute("""
        SELECT posicion, b_column, i_column, n_column, g_column, o_column 
        FROM cartones_maestros 
        WHERE tabla_id = ? 
        ORDER BY posicion ASC;
    """, (tabla_id,))
    
    rows = cursor.fetchall()
    cartones = []
    for r in rows:
        cartones.append({
            "posicion": r["posicion"],
            "B": json.loads(r["b_column"]),
            "I": json.loads(r["i_column"]),
            "N": json.loads(r["n_column"]),
            "G": json.loads(r["g_column"]),
            "O": json.loads(r["o_column"])
        })
        
    return {
        "tabla_id": tabla_id,
        "cartones": cartones
    }

# --- ENDPOINTS TRANSACCIONALES (Reservas y Ventas) ---

@app.post("/api/tickets/reserve")
def reserve_table(data: TableReserve, current_user: Dict[str, Any] = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)):
    cursor = db.cursor()
    
    # 1. Comprobar que existe una partida activa y en estado de ventas ('ACTIVA')
    cursor.execute("SELECT id, estado FROM partidas WHERE estado = 'ACTIVA' ORDER BY id DESC LIMIT 1;")
    partida = cursor.fetchone()
    if not partida:
        raise HTTPException(status_code=400, detail="No hay una partida activa recibiendo compras en este momento.")
        
    partida_id = partida['id']
    tabla_id = data.tabla_id
    
    # 2. Verificar que la tabla esté disponible
    now_str = datetime.utcnow().isoformat()
    cursor.execute("""
        SELECT COUNT(*) FROM tickets_venta 
        WHERE partida_id = ? AND tabla_id = ? AND (estado = 'PAGADO' OR (estado = 'RESERVADO' AND reservado_hasta > ?));
    """, (partida_id, tabla_id, now_str))
    
    occupied = cursor.fetchone()[0]
    if occupied > 0:
        raise HTTPException(status_code=400, detail="Esta tabla ya se encuentra reservada o comprada para esta partida.")
        
    # 3. Crear la reserva por 2 horas (aumentado para evitar pérdida)
    reserva_hasta = (datetime.utcnow() + timedelta(hours=2)).isoformat()
    codigo_reserva = hashlib.md5(f"{partida_id}-{tabla_id}-{current_user['id']}-{random.random()}".encode()).hexdigest()[:8].upper()
    
    cursor.execute("""
        INSERT INTO tickets_venta (partida_id, tabla_id, usuario_id, codigo_reserva, estado, reservado_hasta)
        VALUES (?, ?, ?, ?, 'RESERVADO', ?) RETURNING id;
    """, (partida_id, tabla_id, current_user['id'], codigo_reserva, reserva_hasta))
    
    new_ticket_id = cursor.fetchone()[0]
    db.commit()
    
    return {
        "ticket_id": new_ticket_id,
        "partida_id": partida_id,
        "tabla_id": tabla_id,
        "codigo_reserva": codigo_reserva,
        "estado": "RESERVADO",
        "reservado_hasta": reserva_hasta
    }

# --- LÓGICA DE MONITOREO DE PARTIDA EN VIVO (Para Jugadores) ---

def get_game_state_data(partida_id: int, cursor, current_user_id: int = None):
    cursor.execute("SELECT estado, modalidad, patron_custom FROM partidas WHERE id = ?;", (partida_id,))
    partida = cursor.fetchone()
    if not partida:
        return {"partida_id": None}
        
    estado_partida = partida['estado']
    modalidad_partida = partida['modalidad']
    patron_custom_raw = partida['patron_custom']
    custom_pattern_coords = json.loads(patron_custom_raw) if patron_custom_raw else None
    
    # 2. Obtener bolas extraídas
    cursor.execute("SELECT bola_extraida, orden_extraccion FROM historial_bolillero WHERE partida_id = ? ORDER BY orden_extraccion ASC;", (partida_id,))
    bolas = [r['bola_extraida'] for r in cursor.fetchall()]
    
    # 3. Obtener tickets comprados/reservados por el usuario
    tickets_usuario = []
    if current_user_id:
        now_str = datetime.utcnow().isoformat()
        cursor.execute("""
            SELECT id, tabla_id, codigo_reserva, estado, reservado_hasta 
            FROM tickets_venta 
            WHERE partida_id = ? AND usuario_id = ? AND (estado = 'PAGADO' OR (estado = 'RESERVADO' AND reservado_hasta > ?));
        """, (partida_id, current_user_id, now_str))
        
        tickets_rows = cursor.fetchall()
        for t in tickets_rows:
            tabla_id = t['tabla_id']
            if tabla_id not in CARTONES_CACHE:
                cursor.execute("SELECT posicion, b_column, i_column, n_column, g_column, o_column FROM cartones_maestros WHERE tabla_id = ? ORDER BY posicion ASC;", (tabla_id,))
                cartones_rows = cursor.fetchall()
                cartones = []
                for cr in cartones_rows:
                    cartones.append({
                        "posicion": cr["posicion"],
                        "B": json.loads(cr["b_column"]),
                        "I": json.loads(cr["i_column"]),
                        "N": json.loads(r["n_column"] if 'r' in locals() else cr["n_column"]), # safe fallback
                        "G": json.loads(cr["g_column"]),
                        "O": json.loads(cr["o_column"])
                    })
                CARTONES_CACHE[tabla_id] = cartones
            
            tickets_usuario.append({
                "ticket_id": t['id'],
                "tabla_id": t['tabla_id'],
                "codigo_reserva": t['codigo_reserva'],
                "estado": t['estado'],
                "reservado_hasta": t['reservado_hasta'],
                "cartones": CARTONES_CACHE[tabla_id]
            })
            
    # 4. Comprobar ganadores de la partida actual
    ganadores = []
    if len(bolas) >= 4:
        cursor.execute("SELECT tv.id, tv.tabla_id, u.username FROM tickets_venta tv JOIN usuarios u ON tv.usuario_id = u.id WHERE tv.partida_id = ? AND tv.estado = 'PAGADO';", (partida_id,))
        pagados = cursor.fetchall()
        
        # Validar caché
        cache_key = f"{partida_id}_{len(bolas)}_{len(pagados)}"
        if partida_id in GANADORES_CACHE and GANADORES_CACHE[partida_id].get('key') == cache_key:
            ganadores = GANADORES_CACHE[partida_id]['ganadores']
        else:
            bolas_set = set(bolas)
            evaluar_linea = False
            evaluar_carton = False
            evaluar_custom = False
            
            if pagados:
                tabla_ids = [t['tabla_id'] for t in pagados]
                placeholders = ','.join(['?'] * len(tabla_ids))
                cursor.execute(f"SELECT tabla_id, b_column, i_column, n_column, g_column, o_column FROM cartones_maestros WHERE tabla_id IN ({placeholders});", tuple(tabla_ids))
                
                boards_por_tabla = {tid: [] for tid in set(tabla_ids)}
                for r in cursor.fetchall():
                    boards_por_tabla[r['tabla_id']].append({
                        "B": json.loads(r['b_column']),
                        "I": json.loads(r['i_column']),
                        "N": json.loads(r['n_column']),
                        "G": json.loads(r['g_column']),
                        "O": json.loads(r['o_column'])
                    })
            
                if modalidad_partida == 'LINEA':
                    evaluar_linea = True
                elif modalidad_partida == 'CARTON_LLENO':
                    evaluar_carton = True
                elif modalidad_partida == 'CUSTOM':
                    evaluar_custom = True
                elif modalidad_partida == 'LINEA_Y_CARTON_LLENO':
                    evaluar_carton = True
                    ya_hubo_linea = False
                    if len(bolas) > 4:
                        prev_bolas_set = set(bolas[:-1])
                        for t_check in pagados:
                            board_check = boards_por_tabla[t_check['tabla_id']]
                            if check_table_win(board_check, prev_bolas_set, 'LINEA')[0]:
                                ya_hubo_linea = True
                                break
                    if not ya_hubo_linea:
                        evaluar_linea = True
        
                elif modalidad_partida == 'CUSTOM_Y_CARTON_LLENO':
                    evaluar_carton = True
                    ya_hubo_custom = False
                    if len(bolas) > 0:
                        prev_bolas_set = set(bolas[:-1])
                        for t_check in pagados:
                            board_check = boards_por_tabla[t_check['tabla_id']]
                            if check_table_win(board_check, prev_bolas_set, 'CUSTOM', custom_pattern_coords)[0]:
                                ya_hubo_custom = True
                                break
                    if not ya_hubo_custom:
                        evaluar_custom = True
                
                for ticket in pagados:
                    board = boards_por_tabla[ticket['tabla_id']]
                    
                    win_line, pos_line, pat_line, cells_line = False, None, None, []
                    win_full, pos_full, pat_full, cells_full = False, None, None, []
                    win_custom, pos_custom, pat_custom, cells_custom = False, None, None, []
                    
                    if evaluar_linea:
                        win_line, pos_line, pat_line, cells_line = check_table_win(board, bolas_set, 'LINEA')
                    if evaluar_carton:
                        win_full, pos_full, pat_full, cells_full = check_table_win(board, bolas_set, 'CARTON_LLENO')
                    if evaluar_custom:
                        win_custom, pos_custom, pat_custom, cells_custom = check_table_win(board, bolas_set, 'CUSTOM', custom_pattern_coords)
                    
                    if win_full:
                        ganadores.append({"ticket_id": ticket['id'], "tabla_id": ticket['tabla_id'], "username": ticket['username'], "carton_posicion": pos_full, "patron": "Cartón Lleno", "celdas": cells_full})
                    elif win_custom:
                        ganadores.append({"ticket_id": ticket['id'], "tabla_id": ticket['tabla_id'], "username": ticket['username'], "carton_posicion": pos_custom, "patron": "Patrón Personalizado", "celdas": cells_custom})
                    elif win_line:
                        ganadores.append({"ticket_id": ticket['id'], "tabla_id": ticket['tabla_id'], "username": ticket['username'], "carton_posicion": pos_line, "patron": pat_line, "celdas": cells_line})
            
            # Guardar en caché
            GANADORES_CACHE[partida_id] = {"key": cache_key, "ganadores": ganadores}
                
    return {
        "partida_id": partida_id,
        "estado": estado_partida,
        "modalidad": modalidad_partida,
        "patron_custom": custom_pattern_coords,
        "bolas_extraidas": bolas,
        "tickets": tickets_usuario,
        "ganadores": ganadores
    }

@app.get("/api/game/version")
def get_game_version(db: sqlite3.Connection = Depends(get_db)):
    """Retorna una versión super ligera del estado actual (basado en cuentas de la BD) para polling adaptativo."""
    cursor = db.cursor()
    cursor.execute("SELECT (SELECT COUNT(*) FROM historial_bolillero) + (SELECT COUNT(*) FROM tickets_venta) + (SELECT id FROM partidas ORDER BY id DESC LIMIT 1);")
    version = cursor.fetchone()[0] or 0
    return {"version": version}

@app.get("/api/game/state")
def get_game_state(current_user: Dict[str, Any] = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)):
    """Retorna el estado completo del juego, bolas extraídas y tickets del usuario actual."""
    cursor = db.cursor()
    
    cursor.execute("SELECT id FROM partidas ORDER BY id DESC LIMIT 1;")
    partida = cursor.fetchone()
    if not partida:
        return {"partida": None}
        
    return get_game_state_data(partida['id'], cursor, current_user['id'])

# --- ENDPOINTS EXCLUSIVOS DEL ADMINISTRADOR ---

@app.post("/api/admin/partida/create")
def admin_create_partida(data: PartidaCreate, current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    cursor = db.cursor()
    
    # Obtener el ID de la última partida antes de cerrarla (si aplica)
    cursor.execute("SELECT id FROM partidas ORDER BY id DESC LIMIT 1;")
    last_partida = cursor.fetchone()
    last_partida_id = last_partida['id'] if last_partida else None
    
    # Cancelar/finalizar cualquier partida previa que esté abierta
    cursor.execute("UPDATE partidas SET estado = 'FINALIZADA' WHERE estado IN ('CREADA', 'ACTIVA', 'JUGANDO');")
    
    patron_str = json.dumps(data.patron_custom) if data.patron_custom else None
    cursor.execute("INSERT INTO partidas (estado, modalidad, patron_custom) VALUES ('ACTIVA', ?, ?) RETURNING id;", (data.modalidad, patron_str))
    new_partida_id = cursor.fetchone()[0]
    
    if data.keep_tickets and last_partida_id:
        cursor.execute("SELECT tabla_id, usuario_id, estado, reservado_hasta FROM tickets_venta WHERE partida_id = ? AND estado = 'PAGADO';", (last_partida_id,))
        old_tickets = cursor.fetchall()
        for ot in old_tickets:
            new_code = uuid.uuid4().hex[:8].upper()
            cursor.execute("""
                INSERT INTO tickets_venta (partida_id, tabla_id, usuario_id, codigo_reserva, estado, reservado_hasta)
                VALUES (?, ?, ?, ?, ?, ?);
            """, (new_partida_id, ot['tabla_id'], ot['usuario_id'], new_code, ot['estado'], ot['reservado_hasta']))
        
    db.commit()
    
    return {"message": "Nueva partida creada y lista para recibir ventas (Lobby).", "partida_id": new_partida_id}
@app.get("/api/admin/tickets/reservados")
def admin_list_reserved(current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Lista todos los tickets que están en espera de aprobación de pago para la partida activa."""
    cursor = db.cursor()
    
    cursor.execute("SELECT id FROM partidas ORDER BY id DESC LIMIT 1;")
    active = cursor.fetchone()
    if not active:
        return {"tickets": []}
        
    now_str = datetime.utcnow().isoformat()
    cursor.execute("""
        SELECT tv.id, tv.tabla_id, tv.codigo_reserva, tv.estado, tv.reservado_hasta, u.username
        FROM tickets_venta tv
        JOIN usuarios u ON tv.usuario_id = u.id
        WHERE tv.partida_id = ? AND tv.estado = 'RESERVADO' AND tv.reservado_hasta > ?
        ORDER BY tv.created_at ASC;
    """, (active['id'], now_str))
    
    tickets = [dict(t) for t in cursor.fetchall()]
    return {"tickets": tickets}

@app.get("/api/admin/tickets/all")
def admin_list_all_tickets(current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Lista todos los tickets (PAGADOS y RESERVADOS vigentes) para la partida activa o en curso."""
    cursor = db.cursor()
    
    cursor.execute("SELECT id FROM partidas ORDER BY id DESC LIMIT 1;")
    active = cursor.fetchone()
    if not active:
        return {"tickets": []}
        
    now_str = datetime.utcnow().isoformat()
    cursor.execute("""
        SELECT tv.id, tv.tabla_id, tv.codigo_reserva, tv.estado, u.username
        FROM tickets_venta tv
        JOIN usuarios u ON tv.usuario_id = u.id
        WHERE tv.partida_id = ? AND (tv.estado = 'PAGADO' OR (tv.estado = 'RESERVADO' AND tv.reservado_hasta > ?))
        ORDER BY tv.estado ASC, tv.tabla_id ASC;
    """, (active['id'], now_str))
    
    tickets = [dict(t) for t in cursor.fetchall()]
    
    # Calculate stats
    cursor.execute("SELECT MAX(tabla_id) as max_id FROM cartones_maestros;")
    max_tabla_row = cursor.fetchone()
    total_tablas = max_tabla_row['max_id'] if max_tabla_row and max_tabla_row['max_id'] else 500
    
    all_tablas = set(range(1, total_tablas + 1))
    used_tablas = set([t['tabla_id'] for t in tickets])
    disponibles = sorted(list(all_tablas - used_tablas))
    
    stats = {
        "total": total_tablas,
        "vendidos": len([t for t in tickets if t['estado'] == 'PAGADO']),
        "reservados": len([t for t in tickets if t['estado'] == 'RESERVADO']),
        "disponibles_count": len(disponibles),
        "disponibles_list": disponibles
    }
    
    return {"tickets": tickets, "stats": stats}

@app.post("/api/admin/tickets/{ticket_id}/approve")
def admin_approve_ticket(ticket_id: int, current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Aprueba el pago de una reserva bloqueando permanentemente la tabla para esa partida."""
    cursor = db.cursor()
    cursor.execute("SELECT id, estado, tabla_id, partida_id FROM tickets_venta WHERE id = ?;", (ticket_id,))
    ticket = cursor.fetchone()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket no encontrado.")
        
    if ticket['estado'] != 'RESERVADO':
        raise HTTPException(status_code=400, detail=f"El ticket no está en estado RESERVADO (estado actual: {ticket['estado']}).")
        
    cursor.execute("UPDATE tickets_venta SET estado = 'PAGADO' WHERE id = ?;", (ticket_id,))
    db.commit()
    
    return {"message": f"Pago aprobado con éxito. Tabla #{ticket['tabla_id']} bloqueada e incorporada al juego."}

@app.delete("/api/admin/tickets/{ticket_id}")
def admin_delete_ticket(ticket_id: int, current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Elimina permanentemente un ticket (reservado o pagado) para liberar la tabla o rechazar la compra."""
    cursor = db.cursor()
    cursor.execute("SELECT id, estado, tabla_id FROM tickets_venta WHERE id = ?;", (ticket_id,))
    ticket = cursor.fetchone()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket no encontrado.")
        
    cursor.execute("DELETE FROM tickets_venta WHERE id = ?;", (ticket_id,))
    db.commit()
    
    return {"message": f"Ticket de tabla #{ticket['tabla_id']} eliminado/rechazado correctamente."}

@app.post("/api/admin/partida/start")
def admin_start_game(current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Cierra las ventas y da inicio oficial a la extracción de bolas."""
    cursor = db.cursor()
    cursor.execute("SELECT id, estado FROM partidas WHERE estado = 'ACTIVA' ORDER BY id DESC LIMIT 1;")
    partida = cursor.fetchone()
    if not partida:
        raise HTTPException(status_code=400, detail="No hay una partida en modo de ventas (ACTIVA) para iniciar.")
        
    partida_id = partida['id']
    
    # Opcional: Cancelar automáticamente todas las reservas temporales pendientes que no pagaron
    now_str = datetime.utcnow().isoformat()
    cursor.execute("UPDATE tickets_venta SET estado = 'EXPIRADO' WHERE partida_id = ? AND estado = 'RESERVADO';", (partida_id,))
    
    # Cambiar estado del juego a 'JUGANDO'
    cursor.execute("UPDATE partidas SET estado = 'JUGANDO', updated_at = CURRENT_TIMESTAMP WHERE id = ?;", (partida_id,))
    db.commit()
    
    return {"message": "¡El juego ha comenzado! Ventas cerradas y bolillero activado.", "partida_id": partida_id}

@app.post("/api/admin/partida/draw")
def admin_draw_ball(config: DrawConfig, current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Extrae una balota única del 1 al 75 para la partida en curso."""
    cursor = db.cursor()
    cursor.execute("SELECT id, estado, modalidad FROM partidas WHERE estado = 'JUGANDO' ORDER BY id DESC LIMIT 1;")
    partida = cursor.fetchone()
    if not partida:
        raise HTTPException(status_code=400, detail="No hay una partida en desarrollo activo (JUGANDO) para extraer bolas.")
        
    partida_id = partida['id']
    game_modality = partida['modalidad']
    
    # Obtener bolas ya extraídas
    cursor.execute("SELECT bola_extraida FROM historial_bolillero WHERE partida_id = ?;", (partida_id,))
    drawn = [r[0] for r in cursor.fetchall()]
    
    if len(drawn) >= 75:
        # Finalizar partida automáticamente
        cursor.execute("UPDATE partidas SET estado = 'FINALIZADA' WHERE id = ?;", (partida_id,))
        db.commit()
        raise HTTPException(status_code=400, detail="Se han extraído todas las 75 balotas. El juego ha terminado.")
        
    # Extraer bola única
    available = [n for n in range(1, 76) if n not in drawn]
    
    # Verificar si la partida ya fue completada antes de sacar una nueva bola
    state_data = get_game_state_data(partida_id, cursor)
    current_winners = state_data.get('ganadores', [])
    has_full = any(w['patron'] == 'Cartón Lleno' for w in current_winners)
    has_custom = any(w['patron'] == 'Patrón Personalizado' for w in current_winners)
    has_line = any(w['patron'] not in ['Cartón Lleno', 'Patrón Personalizado'] for w in current_winners)

    is_finished = False
    if game_modality == 'LINEA_Y_CARTON_LLENO' and has_full:
        is_finished = True
    elif game_modality == 'CUSTOM_Y_CARTON_LLENO' and has_full:
        is_finished = True
    elif game_modality == 'CARTON_LLENO' and has_full:
        is_finished = True
    elif game_modality == 'LINEA' and has_line:
        is_finished = True
    elif game_modality == 'CUSTOM' and has_custom:
        is_finished = True

    if is_finished:
        cursor.execute("UPDATE partidas SET estado = 'FINALIZADA' WHERE id = ?;", (partida_id,))
        db.commit()
        raise HTTPException(status_code=400, detail="El juego ya ha finalizado (modalidad completada). No se pueden extraer más bolitas.")
        
    new_ball = random.choice(available)
    next_order = len(drawn) + 1
    
    cursor.execute(
        "INSERT INTO historial_bolillero (partida_id, bola_extraida, orden_extraccion) VALUES (?, ?, ?);",
        (partida_id, new_ball, next_order)
    )
    
    db.commit()
    
    # Recalcular ganadores garantizando que se respeta la progresión (ej. ignorar LINEA si ya hubo una anterior).
    state_after = get_game_state_data(partida_id, cursor)
    ganadores = state_after.get('ganadores', [])
    
    # Si hay algún ganador en modo Cartón Lleno o si se alcanzó algún criterio, el admin puede decidir finalizar
    # Para fines del flujo, si hay ganadores, lo informamos.
    
    return {
        "bola": new_ball,
        "orden": next_order,
        "total_extraidas": len(drawn),
        "ganadores": ganadores
    }

@app.post("/api/admin/partida/end")
def admin_end_game(current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Finaliza oficialmente la partida en curso."""
    cursor = db.cursor()
    cursor.execute("UPDATE partidas SET estado = 'FINALIZADA' WHERE estado IN ('CREADA', 'ACTIVA', 'JUGANDO');")
    db.commit()
    return {"message": "La partida ha sido finalizada formalmente."}

@app.post("/api/admin/partida/reset-all")
def admin_reset_all_data(current_admin: Dict[str, Any] = Depends(get_admin_user), db: sqlite3.Connection = Depends(get_db)):
    """Limpia todo el historial transaccional de partidas, tickets y bolillero para demostraciones limpias."""
    cursor = db.cursor()
    cursor.execute("DELETE FROM historial_bolillero;")
    cursor.execute("DELETE FROM tickets_venta;")
    cursor.execute("DELETE FROM partidas;")
    db.commit()
    return {"message": "Se han reseteado todos los datos transaccionales. Catálogo Maestro preservado intacto."}

@app.get("/api/admin/recover-tickets-manual")
def admin_recover_tickets_manual(db: sqlite3.Connection = Depends(get_db)):
    """Ruta temporal de emergencia para migrar tickets pagados de la penúltima partida a la actual."""
    cursor = db.cursor()
    
    cursor.execute("SELECT id FROM partidas WHERE estado = 'ACTIVA' ORDER BY id DESC LIMIT 1;")
    active_partida = cursor.fetchone()
    if not active_partida:
        return {"error": "No hay partida ACTIVA actualmente. Por favor crea una nueva partida primero."}
        
    partida_actual_id = active_partida['id']
    
    cursor.execute("SELECT id FROM partidas WHERE id < ? ORDER BY id DESC LIMIT 1;", (partida_actual_id,))
    prev_partida = cursor.fetchone()
    if not prev_partida:
        return {"error": "No hay partida anterior de la cual recuperar."}
        
    partida_anterior_id = prev_partida['id']
    
    cursor.execute("SELECT tabla_id, usuario_id, estado, reservado_hasta FROM tickets_venta WHERE partida_id = ? AND estado = 'PAGADO';", (partida_anterior_id,))
    old_tickets = cursor.fetchall()
    
    if not old_tickets:
        return {"message": f"La partida anterior (#{partida_anterior_id}) no tenía cartones pagados."}
        
    cursor.execute("SELECT COUNT(*) as count FROM tickets_venta WHERE partida_id = ?;", (partida_actual_id,))
    current_count = cursor.fetchone()
    if (current_count[0] if isinstance(current_count, tuple) else current_count['count']) > 0:
        return {"error": "La partida actual ya tiene tickets. Para evitar duplicados, no se ejecutó la recuperación."}
        
    count = 0
    import uuid
    for ot in old_tickets:
        new_code = uuid.uuid4().hex[:8].upper()
        cursor.execute("""
            INSERT INTO tickets_venta (partida_id, tabla_id, usuario_id, codigo_reserva, estado, reservado_hasta)
            VALUES (?, ?, ?, ?, ?, ?);
        """, (partida_actual_id, ot['tabla_id'], ot['usuario_id'], new_code, ot['estado'], ot['reservado_hasta']))
        count += 1
        
    db.commit()
    return {"message": f"¡Éxito! Se han recuperado {count} tablas pagadas de la partida #{partida_anterior_id} hacia la partida activa #{partida_actual_id}."}

# --- CONFIGURACIÓN DE ARCHIVOS ESTÁTICOS PARA EL FRONTEND ---
# Buscamos la carpeta 'static' en el workspace. Si no existe, FastAPI no lanzará error si la montamos con un chequeo
static_dir = os.path.join(os.path.dirname(__file__), 'static')
if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

# Inicialización de la base de datos al arrancar
@app.on_event("startup")
def on_startup():
    init_db()
    create_default_admin()

# Crear un admin por defecto al arrancar si no existe
def create_default_admin():
    admin_hash = hash_password("admin123")
    if DATABASE_URL:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()
        try:
            cursor.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (%s, %s, %s);", ("admin", admin_hash, "ADMIN"))
            conn.commit()
            print("Usuario administrador por defecto creado ('admin' / 'admin123').")
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
        conn.close()
    else:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        try:
            cursor.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?);", ("admin", admin_hash, "ADMIN"))
            conn.commit()
            print("Usuario administrador por defecto creado ('admin' / 'admin123').")
        except sqlite3.IntegrityError:
            pass
        conn.close()

