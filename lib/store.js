'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Almacen de ficheros JSON con escritura atomica (fichero temporal + rename)
// y una cola por fichero, para que dos peticiones simultaneas no se pisen.
// El servidor es de un solo usuario, asi que no hace falta mas que esto.

const COLECCIONES = {
  config: 'objeto',
  clientes: 'lista',
  facturas: 'lista',
  gastos: 'lista',
  bienes: 'lista',
  presentaciones: 'lista',
};

const CONFIG_INICIAL = {
  emisor: {
    nombre: '',
    nif: '',
    direccion: '',
    cp: '',
    poblacion: '',
    provincia: '',
    email: '',
    telefono: '',
    iban: '',
    epigrafe: '763 - Programadores y analistas de informatica',
  },
  serie: 'A',
  siguienteNumero: 1,
  serieRectificativa: 'R',
  siguienteRectificativa: 1,
  tipoIva: 21,
  tipoIrpf: 15,
  presenta130: true,
  vencimientoDias: 30,
  // Ajustes avanzados: parametros normativos que casi nunca se tocan.
  avanzado: {
    porcentaje130: 20,
    rendimientoEjercicioAnterior: 0,
    saldoIvaInicial: 0,
    anioInicioActividad: new Date().getFullYear(),
  },
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.backupDir = path.join(dir, 'backups');
    this.colas = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  ruta(nombre) {
    return path.join(this.dir, `${nombre}.json`);
  }

  async leer(nombre) {
    const tipo = COLECCIONES[nombre];
    if (!tipo) throw new Error(`Coleccion desconocida: ${nombre}`);
    try {
      const txt = await fsp.readFile(this.ruta(nombre), 'utf8');
      return JSON.parse(txt);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return tipo === 'lista' ? [] : structuredClone(CONFIG_INICIAL);
      }
      throw err;
    }
  }

  // Serializa las escrituras sobre la misma coleccion.
  async escribir(nombre, datos) {
    const anterior = this.colas.get(nombre) || Promise.resolve();
    const tarea = anterior.then(() => this._escribirAhora(nombre, datos));
    this.colas.set(
      nombre,
      tarea.catch(() => {})
    );
    return tarea;
  }

  async _escribirAhora(nombre, datos) {
    const destino = this.ruta(nombre);
    const tmp = `${destino}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
    await fsp.rename(tmp, destino);
    return datos;
  }

  // Modificacion leer-transformar-escribir dentro de la misma cola.
  async actualizar(nombre, fn) {
    const anterior = this.colas.get(nombre) || Promise.resolve();
    const tarea = anterior.then(async () => {
      const actual = await this.leer(nombre);
      const nuevo = await fn(actual);
      await this._escribirAhora(nombre, nuevo);
      return nuevo;
    });
    this.colas.set(
      nombre,
      tarea.catch(() => {})
    );
    return tarea;
  }

  // Copia de seguridad: un JSON con todo, fechado. Se conservan 30.
  async backup(etiqueta = '') {
    const todo = {};
    for (const nombre of Object.keys(COLECCIONES)) todo[nombre] = await this.leer(nombre);
    const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nombreFichero = `backup-${sello}${etiqueta ? `-${etiqueta}` : ''}.json`;
    const destino = path.join(this.backupDir, nombreFichero);
    await fsp.writeFile(destino, JSON.stringify(todo, null, 2), 'utf8');
    await this.podarBackups(30);
    return { fichero: nombreFichero, ruta: destino };
  }

  async podarBackups(conservar) {
    const ficheros = (await fsp.readdir(this.backupDir))
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
    const sobran = ficheros.slice(0, Math.max(0, ficheros.length - conservar));
    await Promise.all(sobran.map((f) => fsp.unlink(path.join(this.backupDir, f)).catch(() => {})));
  }

  async exportar() {
    const todo = {};
    for (const nombre of Object.keys(COLECCIONES)) todo[nombre] = await this.leer(nombre);
    return todo;
  }

  async importar(datos) {
    await this.backup('previo-a-importar');
    for (const nombre of Object.keys(COLECCIONES)) {
      if (datos[nombre] !== undefined) await this.escribir(nombre, datos[nombre]);
    }
  }
}

module.exports = { Store, CONFIG_INICIAL, COLECCIONES };
