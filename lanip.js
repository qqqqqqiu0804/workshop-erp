var os = require('os');
var n = os.networkInterfaces();
var keys = Object.keys(n);

// 虚拟/隧道网卡一律排除：WSL、Hyper-V、VirtualBox、VMware、Docker、
// ZeroTier、Tailscale、TAP/TUN、VPN、teredo、isatap 等
var virtualRe = /(vethernet|wsl|hyper-?v|virtualbox|vmware|docker|zerotier|tailscale|\btap\b|\btun\b|\bvpn\b|loopback|teredo|isatap|miniport)/i;

var candidates = [];
for (var ki = 0; ki < keys.length; ki++) {
  var name = keys[ki];
  if (virtualRe.test(name)) continue; // 跳过虚拟网卡
  var list = n[name];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (a.family !== 'IPv4' || a.internal) continue;
    var ip = a.address;
    if (/^169\.254\./.test(ip)) continue; // 跳过链路本地
    var priv = /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
    candidates.push({ ip: ip, priv: priv, name: name });
  }
}

// 优先私网地址（192.168/10/172.16-31），其余兜底
candidates.sort(function (x, y) { return (y.priv ? 1 : 0) - (x.priv ? 1 : 0); });

console.log(candidates.length ? candidates[0].ip : '127.0.0.1');
