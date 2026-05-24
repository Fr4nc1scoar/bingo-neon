from typing import List, Dict, Set, Tuple

def get_card_matrix(card: Dict[str, List[int]]) -> List[List[int]]:
    """
    Convierte el formato de columnas de un cartón {'B': [...], 'I': [...], ...}
    en una matriz de 5x5 accesible por filas [fila][columna].
    """
    letters = ['B', 'I', 'N', 'G', 'O']
    matrix = [[0] * 5 for _ in range(5)]
    for r in range(5):
        for c in range(5):
            letter = letters[c]
            matrix[r][c] = card[letter][r]
    return matrix

def check_card_win(card: Dict[str, List[int]], drawn_numbers: Set[int], mode: str = 'CARTON_LLENO', custom_pattern: List[Tuple[int, int]] = None) -> Tuple[bool, str, List[Tuple[int, int]]]:
    """
    Verifica si un cartón de Bingo cumple con el patrón ganador según el modo.
    Soporta:
    - 'LINEA': 5 celdas marcadas en horizontal, vertical o diagonal.
    - 'CARTON_LLENO': Las 24 celdas del cartón marcadas.
    - 'CUSTOM': Las celdas especificadas en custom_pattern marcadas.
    
    Retorna:
      Tuple[ganador (bool), patron_nombre (str), celdas_ganadoras (list of tuples (row, col))]
    """
    matrix = get_card_matrix(card)
    
    # Casilla central (2,2) es FREE (0), siempre se considera marcada
    def is_marked(r: int, c: int) -> bool:
        if r == 2 and c == 2:
            return True
        val = matrix[r][c]
        return val in drawn_numbers

    # --- MODO: LÍNEA ---
    if mode == 'LINEA':
        # 1. Comprobar Filas (Horizontales)
        for r in range(5):
            if all(is_marked(r, c) for c in range(5)):
                winning_cells = [(r, c) for c in range(5)]
                return True, f"Línea Horizontal (Fila {r+1})", winning_cells
                
        # 2. Comprobar Columnas (Verticales)
        letters = ['B', 'I', 'N', 'G', 'O']
        for c in range(5):
            if all(is_marked(r, c) for r in range(5)):
                winning_cells = [(r, c) for r in range(5)]
                return True, f"Línea Vertical (Columna {letters[c]})", winning_cells
                
        # 3. Comprobar Diagonal Principal (Top-Left to Bottom-Right)
        if all(is_marked(i, i) for i in range(5)):
            winning_cells = [(i, i) for i in range(5)]
            return True, "Diagonal Principal", winning_cells
            
        # 4. Comprobar Diagonal Secundaria (Top-Right to Bottom-Left)
        if all(is_marked(i, 4 - i) for i in range(5)):
            winning_cells = [(i, 4 - i) for i in range(5)]
            return True, "Diagonal Secundaria", winning_cells

    # --- MODO: CARTÓN LLENO ---
    elif mode == 'CARTON_LLENO':
        # Comprobar si todas las celdas están marcadas
        all_marked = True
        winning_cells = []
        for r in range(5):
            for c in range(5):
                if not is_marked(r, c):
                    all_marked = False
                winning_cells.append((r, c))
        if all_marked:
            return True, "Cartón Lleno", winning_cells

    # --- MODO: CUSTOM ---
    elif mode == 'CUSTOM':
        if not custom_pattern:
            return False, "", []
        all_marked = True
        winning_cells = []
        for r, c in custom_pattern:
            if not is_marked(r, c):
                all_marked = False
            winning_cells.append((r, c))
        if all_marked:
            return True, "Patrón Personalizado", winning_cells

    return False, "", []

def check_table_win(board_cards: List[Dict[str, List[int]]], drawn_numbers: Set[int], mode: str = 'CARTON_LLENO', custom_pattern: List[Tuple[int, int]] = None) -> Tuple[bool, int, str, List[Tuple[int, int]]]:
    """
    Verifica si alguno de los 4 cartones de la tabla es ganador de forma independiente.
    
    Retorna:
      Tuple[ganador (bool), posicion_carton_1_4 (int), patron_nombre (str), celdas_ganadoras]
    """
    for idx, card in enumerate(board_cards, start=1):
        win, pattern, cells = check_card_win(card, drawn_numbers, mode, custom_pattern)
        if win:
            return True, idx, pattern, cells
    return False, 0, "", []
