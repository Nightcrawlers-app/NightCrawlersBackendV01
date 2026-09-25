/**
 * Works out WHY MongoDB won't connect, step by step.
 *
 *   node scripts/checkMongo.js
 *
 * Safe to share the output: it never prints your password.
 */
require('dotenv').config();
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI || '';

const publicIp = () =>
  new Promise((resolve) => {
    https
      .get('https://api.ipify.org', (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d.trim()));
      })
      .on('error', (e) => resolve(`unknown (${e.message})`))
      .setTimeout(8000, function () {
        this.destroy();
        resolve('unknown (timeout)');
      });
  });

const tcpCheck = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(8000, () => done('TIMED OUT (port blocked, or IP not on the Atlas list)'));
    s.on('connect', () => done('reachable ✅'));
    s.on('error', (e) => done(`error: ${e.code || e.message}`));
  });

(async () => {
  console.log('\n1) Your public IP (this is what goes on the Atlas list):', await publicIp());

  if (!uri) return console.log('\n❌ MONGODB_URI is empty in .env');
  const m = uri.match(/^(mongodb(?:\+srv)?):\/\/(?:[^@]*@)?([^/?]+)/);
  if (!m) return console.log('\n❌ MONGODB_URI does not look like a MongoDB address');
  const [, scheme, hostPart] = m;
  console.log('2) Connection string type:', scheme, '| cluster host:', hostPart);

  let targets = hostPart.split(',').map((h) => {
    const [host, port] = h.split(':');
    return { host, port: Number(port) || 27017 };
  });

  if (scheme === 'mongodb+srv') {
    try {
      const srv = await dns.resolveSrv(`_mongodb._tcp.${hostPart}`);
      targets = srv.map((r) => ({ host: r.name, port: r.port }));
      console.log(`3) DNS lookup: found ${targets.length} servers ✅`);
    } catch (e) {
      console.log(`3) DNS lookup FAILED ❌ (${e.code}). Your internet/DNS can't find the cluster.`);
      console.log('   Try: switch network (phone hotspot), or set Windows DNS to 8.8.8.8 / 1.1.1.1.');
      return;
    }
  }

  console.log('4) Can this computer reach each server on its port?');
  for (const t of targets) console.log(`   ${t.host}:${t.port} → ${await tcpCheck(t.host, t.port)}`);

  console.log('5) Full connection attempt (15s)…');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    console.log('   CONNECTED ✅ — database:', mongoose.connection.name);
  } catch (err) {
    console.log('   FAILED ❌', err.name, '-', err.message.split('.')[0]);
    const servers = err.reason?.servers;
    if (servers) {
      for (const [host, desc] of servers) {
        console.log(`   ${host}: ${desc.error ? desc.error.message : desc.type}`);
      }
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
