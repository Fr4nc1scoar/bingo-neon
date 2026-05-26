import threading
import urllib.request
import json
import time
import random

BASE_URL = "https://bingo-neon.onrender.com"
NUM_CLIENTS = 500

def simulate_client(client_id):
    version = -1
    
    while True:
        try:
            req = urllib.request.Request(f"{BASE_URL}/api/game/version")
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode())
                    v = data.get("version", -1)
                    if v != version:
                        version = v
            
            # Poll between 1.5 and 2.5 seconds to simulate real users
            time.sleep(random.uniform(1.5, 2.5))
        except Exception as e:
            time.sleep(5)

print(f"Iniciando prueba de estrés masiva con {NUM_CLIENTS} clientes...")
threads = []
for i in range(NUM_CLIENTS):
    t = threading.Thread(target=simulate_client, args=(i,))
    t.daemon = True
    t.start()
    threads.append(t)
    if i % 50 == 0:
        print(f"{i} clientes iniciados...")
        time.sleep(0.05)

print("Todos los clientes iniciados. El servidor está recibiendo la carga de 500 usuarios.")
print("Abre el administrador de tareas para ver el rendimiento.")
print("Presiona Ctrl+C para detener la prueba.")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("Prueba finalizada.")
