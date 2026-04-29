import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET || 'geheimer-key';
const BRIDGE_BOT_URL = process.env.BRIDGE_BOT_URL || '';
const ADMIN_IDS      = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID     = Number(process.env.GROUP_A_ID);
const GROUP_B_ID     = Number(process.env.GROUP_B_ID);
const MEINE_GRUPPE   = 'B';

process.env.TZ = 'Europe/Berlin';