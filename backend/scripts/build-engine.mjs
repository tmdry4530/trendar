#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');
const ENGINE_DIR = path.join(ROOT_DIR, 'security-engine');
const NATIVE_DIR = path.join(BACKEND_DIR, 'native');

const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const cargoArgs = ['build', '--manifest-path', path.join(ENGINE_DIR, 'Cargo.toml')];
if (profile === 'release') cargoArgs.push('--release');

console.log(`[build-engine] cargo ${cargoArgs.join(' ')}`);
execFileSync('cargo', cargoArgs, { stdio: 'inherit' });

const targetDir = path.join(ENGINE_DIR, 'target', profile);
const libName =
  process.platform === 'darwin'
    ? 'libtrendar_engine_napi.dylib'
    : process.platform === 'win32'
      ? 'trendar_engine_napi.dll'
      : 'libtrendar_engine_napi.so';
const cliName = process.platform === 'win32' ? 'trendar-scan.exe' : 'trendar-scan';

const srcLib = path.join(targetDir, libName);
const srcCli = path.join(targetDir, cliName);

if (!fs.existsSync(srcLib)) {
  throw new Error(`[build-engine] expected native library not found: ${srcLib}`);
}

fs.mkdirSync(NATIVE_DIR, { recursive: true });
const dstNode = path.join(NATIVE_DIR, 'trendar_engine.node');
fs.copyFileSync(srcLib, dstNode);
console.log(`[build-engine] installed native addon -> ${dstNode}`);

if (fs.existsSync(srcCli)) {
  const dstCli = path.join(NATIVE_DIR, cliName);
  fs.copyFileSync(srcCli, dstCli);
  if (process.platform !== 'win32') fs.chmodSync(dstCli, 0o755);
  console.log(`[build-engine] installed CLI binary  -> ${dstCli}`);
}
