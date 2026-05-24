import random
import hashlib
import json
import sqlite3
from typing import List, Dict, Tuple, Set, Optional

# Rangos oficiales del Bingo Americano de 75 bolas
POOLS = {
    'B': list(range(1, 16)),    # 1 a 15
    'I': list(range(16, 31)),   # 16 a 30
    'N': list(range(31, 46)),   # 31 a 45
    'G': list(range(46, 61)),   # 46 a 60
    'O': list(range(61, 76))    # 61 a 75
}

def generate_random_column(pool: List[int], spaces: int) -> List[int]:
    """
    Genera una columna de Bingo clásica:
    Selecciona 'spaces' números únicos del pool completamente al azar y los ordena ascendentemente.
    Esto garantiza aleatoriedad pura en cada cartón individual.
    """
    return sorted(random.sample(pool, spaces))

def generate_board() -> List[Dict[str, List[int]]]:
    """
    Genera una sola tabla (Board) que consta de 4 cartones (Cards) generados de manera
    completamente independiente y aleatoria, al estilo de las aplicaciones comerciales clásicas.
    """
    cards = []
    for _ in range(4):
        # Cada cartón se genera de forma independiente
        b_col = generate_random_column(POOLS['B'], 5)
        i_col = generate_random_column(POOLS['I'], 5)
        n_col = generate_random_column(POOLS['N'], 4) # 4 números del pool
        g_col = generate_random_column(POOLS['G'], 5)
        o_col = generate_random_column(POOLS['O'], 5)
        
        # Insertar el 0 (FREE SPACE) en la posición central de la columna N (índice 2)
        n_col_with_free = [n_col[0], n_col[1], 0, n_col[2], n_col[3]]
        
        card = {
            'B': b_col,
            'I': i_col,
            'N': n_col_with_free,
            'G': g_col,
            'O': o_col
        }
        cards.append(card)
        
    return cards

def compute_card_hash(card: Dict[str, List[int]]) -> str:
    """
    Calcula un hash SHA-256 único y canónico para un cartón de Bingo.
    """
    serialized = json.dumps(card, sort_keys=True)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()

def compute_board_signature(card_hashes: List[str]) -> str:
    """
    Calcula una firma única para la tabla ordenando los hashes de sus 4 cartones.
    Garantiza la unicidad de la tabla sin importar el orden físico de sus cartones.
    """
    sorted_hashes = sorted(card_hashes)
    serialized = ",".join(sorted_hashes)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()

def generate_master_catalog(db_path: str, count: int = 500) -> Tuple[int, int]:
    """
    Genera y guarda en la base de datos el catálogo maestro de 500 tablas.
    Garantiza unicidad de cartones a nivel global y de tablas a nivel global.
    Retorna (tablas_creadas, cartones_creados).
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Habilitar claves foráneas
    cursor.execute("PRAGMA foreign_keys = ON;")
    
    # Limpiar catálogo existente para garantizar consistencia
    cursor.execute("DELETE FROM cartones_maestros;")
    cursor.execute("DELETE FROM tablas_maestras;")
    conn.commit()
    
    global_card_hashes: Set[str] = set()
    global_board_signatures: Set[str] = set()
    
    boards_created = 0
    cartons_created = 0
    
    while boards_created < count:
        board_cards = generate_board()
            
        # Calcular hashes de cada cartón
        card_hashes = [compute_card_hash(c) for c in board_cards]
        
        # 1. Validar que ningún cartón del board sea idéntico a otro cartón global
        if any(h in global_card_hashes for h in card_hashes):
            continue # Colisión de cartón, descartar tabla y reintentar
            
        # 2. Validar que la combinación de cartones (tabla) sea única
        board_sig = compute_board_signature(card_hashes)
        if board_sig in global_board_signatures:
            continue # Colisión de tabla, descartar y reintentar
            
        # Tabla válida y única! Registrar en base de datos
        tabla_id = boards_created + 1
        
        cursor.execute("INSERT INTO tablas_maestras (id) VALUES (?);", (tabla_id,))
        
        for pos, (card, chash) in enumerate(zip(board_cards, card_hashes), start=1):
            cursor.execute("""
                INSERT INTO cartones_maestros (
                    tabla_id, posicion, b_column, i_column, n_column, g_column, o_column, hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            """, (
                tabla_id,
                pos,
                json.dumps(card['B']),
                json.dumps(card['I']),
                json.dumps(card['N']),
                json.dumps(card['G']),
                json.dumps(card['O']),
                chash
            ))
            global_card_hashes.add(chash)
            cartons_created += 1
            
        global_board_signatures.add(board_sig)
        boards_created += 1
        
    conn.commit()
    conn.close()
    return boards_created, cartons_created

if __name__ == '__main__':
    db_test_path = 'bingo.db'
    print("Generando catálogo maestro aleatorio de 500 tablas estáticas...")
    tables, cards = generate_master_catalog(db_test_path, 500)
    print(f"Catálogo generado con éxito: {tables} tablas y {cards} cartones guardados en '{db_test_path}'.")
