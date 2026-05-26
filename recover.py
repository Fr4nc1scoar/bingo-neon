import sys
import os
import uuid
import sqlite3
import json

sys.path.append(os.getcwd())
try:
    from app import DB_PATH
except ImportError:
    DB_PATH = 'bingo.db'

def recover_tickets():
    if not os.path.exists(DB_PATH):
        print(f"Error: Base de datos {DB_PATH} no encontrada.")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        # 1. Encontrar la partida ACTIVA actual
        cursor.execute("SELECT id FROM partidas WHERE estado = 'ACTIVA' ORDER BY id DESC LIMIT 1;")
        active = cursor.fetchone()
        if not active:
            print("Error: No hay partida ACTIVA actualmente.")
            return
        current_id = active['id']

        # 2. Encontrar la partida anterior
        cursor.execute("SELECT id FROM partidas WHERE id < ? ORDER BY id DESC LIMIT 1;", (current_id,))
        prev = cursor.fetchone()
        if not prev:
            print("Error: No existe una partida anterior para recuperar.")
            return
        prev_id = prev['id']

        # 3. Traer los tickets PAGADOS de la partida anterior
        cursor.execute("SELECT tabla_id, usuario_id, estado, reservado_hasta FROM tickets_venta WHERE partida_id = ? AND estado = 'PAGADO';", (prev_id,))
        old_tickets = cursor.fetchall()

        if not old_tickets:
            print(f"La partida anterior (#{prev_id}) no tenía cartones pagados.")
            return

        # 4. Verificar duplicados
        cursor.execute("SELECT COUNT(*) as c FROM tickets_venta WHERE partida_id = ?;", (current_id,))
        if cursor.fetchone()['c'] > 0:
            print("Error: La partida actual ya tiene tickets. Para evitar duplicados, no se ejecutó la recuperación.")
            return

        # 5. Inyectarlos a la partida actual
        count = 0
        for ot in old_tickets:
            new_code = uuid.uuid4().hex[:8].upper()
            cursor.execute("""
                INSERT INTO tickets_venta (partida_id, tabla_id, usuario_id, codigo_reserva, estado, reservado_hasta)
                VALUES (?, ?, ?, ?, ?, ?);
            """, (current_id, ot['tabla_id'], ot['usuario_id'], new_code, ot['estado'], ot['reservado_hasta']))
            count += 1

        conn.commit()
        print(f"¡Éxito! Se recuperaron {count} tablas pagadas de la partida #{prev_id} a la partida activa #{current_id}.")

    except Exception as e:
        print(f"Ocurrió un error: {e}")
    finally:
        conn.close()

if __name__ == '__main__':
    recover_tickets()
