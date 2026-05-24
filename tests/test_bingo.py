import unittest
import sqlite3
import json
import os
from typing import List, Dict

from core.generator import generate_master_catalog, generate_board, POOLS
from core.validator import check_card_win, check_table_win

class TestBingoCore(unittest.TestCase):
    
    @classmethod
    def setUpClass(cls):
        cls.db_test = 'bingo_test.db'
        if os.path.exists(cls.db_test):
            os.remove(cls.db_test)
            
        conn = sqlite3.connect(cls.db_test)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tablas_maestras (
                id INTEGER PRIMARY KEY
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cartones_maestros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tabla_id INTEGER NOT NULL,
                posicion INTEGER NOT NULL,
                b_column TEXT NOT NULL,
                i_column TEXT NOT NULL,
                n_column TEXT NOT NULL,
                g_column TEXT NOT NULL,
                o_column TEXT NOT NULL,
                hash TEXT NOT NULL UNIQUE
            );
        """)
        conn.commit()
        conn.close()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.db_test):
            os.remove(cls.db_test)

    def test_01_catalog_generation_counts(self):
        """Prueba que el generador crea exactamente 10 tablas y 40 cartones únicos en test."""
        tables_created, cards_created = generate_master_catalog(self.db_test, 10)
        self.assertEqual(tables_created, 10)
        self.assertEqual(cards_created, 40)
        
        conn = sqlite3.connect(self.db_test)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM tablas_maestras;")
        self.assertEqual(cursor.fetchone()[0], 10)
        
        cursor.execute("SELECT COUNT(*) FROM cartones_maestros;")
        self.assertEqual(cursor.fetchone()[0], 40)
        conn.close()

    def test_02_unicity_and_hashes(self):
        """Prueba que no haya cartones duplicados en todo el lote generado."""
        conn = sqlite3.connect(self.db_test)
        cursor = conn.cursor()
        cursor.execute("SELECT hash FROM cartones_maestros;")
        hashes = [row[0] for row in cursor.fetchall()]
        conn.close()
        
        self.assertEqual(len(hashes), len(set(hashes)))

    def test_03_card_number_ranges_and_sorting(self):
        """Prueba que los números en cada columna respeten sus rangos oficiales y estén ordenados."""
        board = generate_board()
        self.assertEqual(len(board), 4) # 4 cartones por tabla
        
        for idx, card in enumerate(board):
            # Column B (1 - 15)
            b_col = card['B']
            self.assertEqual(len(b_col), 5)
            self.assertEqual(len(set(b_col)), 5)
            self.assertTrue(all(1 <= n <= 15 for n in b_col))
            self.assertEqual(b_col, sorted(b_col))
            
            # Column I (16 - 30)
            i_col = card['I']
            self.assertEqual(len(i_col), 5)
            self.assertEqual(len(set(i_col)), 5)
            self.assertTrue(all(16 <= n <= 30 for n in i_col))
            self.assertEqual(i_col, sorted(i_col))
            
            # Column N (31 - 45, centro 0)
            n_col = card['N']
            self.assertEqual(len(n_col), 5)
            self.assertEqual(n_col[2], 0, "La casilla del centro debe ser 0 (FREE SPACE).")
            n_numbers = n_col[:2] + n_col[3:]
            self.assertEqual(len(set(n_numbers)), 4)
            self.assertTrue(all(31 <= n <= 45 for n in n_numbers))
            self.assertEqual(n_col[:2], sorted(n_col[:2]))
            self.assertEqual(n_col[3:], sorted(n_col[3:]))
            
            # Column G (46 - 60)
            g_col = card['G']
            self.assertEqual(len(g_col), 5)
            self.assertEqual(len(set(g_col)), 5)
            self.assertTrue(all(46 <= n <= 60 for n in g_col))
            self.assertEqual(g_col, sorted(g_col))
            
            # Column O (61 - 75)
            o_col = card['O']
            self.assertEqual(len(o_col), 5)
            self.assertEqual(len(set(o_col)), 5)
            self.assertTrue(all(61 <= n <= 75 for n in o_col))
            self.assertEqual(o_col, sorted(o_col))

    def test_04_validator_linea_horizontal(self):
        """Verifica que el validador detecte correctamente líneas horizontales."""
        card = {
            'B': [1, 2, 3, 4, 5],
            'I': [16, 17, 18, 19, 20],
            'N': [31, 32, 0, 33, 34],
            'G': [46, 47, 48, 49, 50],
            'O': [61, 62, 63, 64, 65]
        }
        
        # Fila 0: 1, 16, 31, 46, 61
        drawn = {1, 16, 31, 46, 61}
        win, pattern, cells = check_card_win(card, drawn, 'LINEA')
        self.assertTrue(win)
        self.assertIn("Fila 1", pattern)
        self.assertEqual(cells, [(0,0), (0,1), (0,2), (0,3), (0,4)])
        
        # Fila 2: 3, 18, 0, 48, 63 (contiene FREE = 0)
        drawn_f2 = {3, 18, 48, 63}
        win, pattern, cells = check_card_win(card, drawn_f2, 'LINEA')
        self.assertTrue(win)
        self.assertIn("Fila 3", pattern)

    def test_05_validator_linea_vertical(self):
        """Verifica que el validador detecte correctamente líneas verticales."""
        card = {
            'B': [1, 2, 3, 4, 5],
            'I': [16, 17, 18, 19, 20],
            'N': [31, 32, 0, 33, 34],
            'G': [46, 47, 48, 49, 50],
            'O': [61, 62, 63, 64, 65]
        }
        
        drawn = {16, 17, 18, 19, 20}
        win, pattern, cells = check_card_win(card, drawn, 'LINEA')
        self.assertTrue(win)
        self.assertIn("Columna I", pattern)

    def test_06_validator_diagonales(self):
        """Verifica que el validador detecte diagonales."""
        card = {
            'B': [1, 2, 3, 4, 5],
            'I': [16, 17, 18, 19, 20],
            'N': [31, 32, 0, 33, 34],
            'G': [46, 47, 48, 49, 50],
            'O': [61, 62, 63, 64, 65]
        }
        
        drawn_d1 = {1, 17, 49, 65}
        win, pattern, cells = check_card_win(card, drawn_d1, 'LINEA')
        self.assertTrue(win)
        self.assertEqual(pattern, "Diagonal Principal")
        
        drawn_d2 = {5, 19, 47, 61}
        win, pattern, cells = check_card_win(card, drawn_d2, 'LINEA')
        self.assertTrue(win)
        self.assertEqual(pattern, "Diagonal Secundaria")

    def test_07_validator_carton_lleno(self):
        """Verifica que el validador detecte cartón lleno."""
        card = {
            'B': [1, 2, 3, 4, 5],
            'I': [16, 17, 18, 19, 20],
            'N': [31, 32, 0, 33, 34],
            'G': [46, 47, 48, 49, 50],
            'O': [61, 62, 63, 64, 65]
        }
        
        drawn_partial = {1, 2, 3, 4, 16, 17, 18, 19, 20, 31, 32, 33, 34, 46, 47, 48, 49, 50, 61, 62, 63, 64, 65}
        win, pattern, cells = check_card_win(card, drawn_partial, 'CARTON_LLENO')
        self.assertFalse(win)
        
        drawn_all = drawn_partial.union({5})
        win, pattern, cells = check_card_win(card, drawn_all, 'CARTON_LLENO')
        self.assertTrue(win)
        self.assertEqual(pattern, "Cartón Lleno")

    def test_08_validator_custom(self):
        """Verifica que el validador procese patrones CUSTOM basados en coordenadas de usuario."""
        card = {
            'B': [1, 2, 3, 4, 5],
            'I': [16, 17, 18, 19, 20],
            'N': [31, 32, 0, 33, 34],
            'G': [46, 47, 48, 49, 50],
            'O': [61, 62, 63, 64, 65]
        }
        # Patrón custom con forma de cruz pequeña alrededor del centro: (1,2), (2,1), (2,3), (3,2)
        custom_coords = [[1, 2], [2, 1], [2, 3], [3, 2]]
        
        # Le faltan algunas bolas
        drawn_partial = {32, 18} # (1,2) es 32, (2,1) es 18. Faltan (2,3) es 48 y (3,2) es 33
        win, pattern, cells = check_card_win(card, drawn_partial, 'CUSTOM', custom_coords)
        self.assertFalse(win)
        
        # Salen todas
        drawn_all = {32, 18, 48, 33}
        win, pattern, cells = check_card_win(card, drawn_all, 'CUSTOM', custom_coords)
        self.assertTrue(win)
        self.assertEqual(pattern, "Patrón Personalizado")
        self.assertEqual(len(cells), 4) # 4 coordenadas custom

if __name__ == '__main__':
    unittest.main()
