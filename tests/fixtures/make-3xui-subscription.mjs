// Builds a subscription body in the shape 3x-ui panels hand out: one base64
// blob with mixed links. Used to reproduce real-world import failures.
import { readFileSync, writeFileSync } from 'node:fs';

const id = '11111111-2222-3333-4444-555555555555';
const links = [
  `vless://${id}@de1.example.com:443?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fp=chrome&sni=www.microsoft.com&sid=ab12&spx=%2F&flow=xtls-rprx-vision&encryption=none#🇩🇪 Германия 1`,
  `vless://${id}@de2.example.com:443?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fp=chrome&sni=www.microsoft.com&sid=ab12&spx=%2F&flow=xtls-rprx-vision&encryption=none&headerType=none#🇩🇪 Германия 2`,
  `vless://${id}@de3.example.com:8443?type=ws&security=tls&sni=de3.example.com&host=de3.example.com&path=%2Fws%3Fed%3D2048&allowInsecure=1#🇩🇪 Германия 3`,
  `vless://${id}@de4.example.com:443?type=grpc&security=tls&sni=de4.example.com&serviceName=grpcsvc&mode=gun#🇩🇪 Германия 4`,
  `vless://${id}@de5.example.com:443?type=xhttp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fp=chrome&sni=www.microsoft.com&sid=ab12&path=%2Fx&mode=auto&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#🇩🇪 Германия 5`,
  `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: '🇳🇱 Нидерланды 1', add: 'nl1.example.com', port: '443', id, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'nl1.example.com', path: '/ws', tls: 'tls', sni: 'nl1.example.com' })).toString('base64')}`,
  `trojan://pass123@nl2.example.com:443?security=tls&sni=nl2.example.com&type=tcp&allowInsecure=1#🇳🇱 Нидерланды 2`,
  `trojan://pass123@nl3.example.com:443?security=tls&sni=nl3.example.com&type=ws&path=%2Ftj#🇳🇱 Нидерланды 3`,
  `ss://${Buffer.from('aes-256-gcm:pass123').toString('base64')}@nl4.example.com:8388#🇳🇱 Нидерланды 4`,
  `hysteria2://pass123@fi1.example.com:443?sni=fi1.example.com&insecure=1#🇫🇮 Финляндия 1`,
  `hysteria2://pass123@fi2.example.com:443?sni=fi2.example.com&obfs=salamander&obfs-password=xyz#🇫🇮 Финляндия 2`,
  `vless://${id}@fr1.example.com:443?type=tcp&security=tls&sni=fr1.example.com&flow=xtls-rprx-vision&allowInsecure=1#🇫🇷 Франция 1`,
  `vless://${id}@fr2.example.com:443?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fp=chrome&sni=www.microsoft.com&sid=ab12&spx=%2F#🇫🇷 Франция 2`,
  `vless://${id}@us1.example.com:443?type=ws&security=tls&sni=us1.example.com&host=us1.example.com&path=%2Fws#🇺🇸 США 1`,
  `vless://${id}@us2.example.com:443?type=grpc&security=tls&sni=us2.example.com&serviceName=grpc&mode=multi#🇺🇸 США 2`,
  `vless://${id}@uk1.example.com:443?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fp=chrome&sni=www.microsoft.com&sid=ab12&spx=%2F&flow=xtls-rprx-vision&encryption=none&pqv=BBB#🇬🇧 Великобритания 1`,
  `vless://${id}@ru1.example.com:443?type=tcp&security=tls&sni=ru1.example.com&alpn=h2,http%2F1.1#🇷🇺 Россия 1`,
  `shadowsocks://${Buffer.from('chacha20-poly1305:pass123').toString('base64')}@uk2.example.com:8388#🇬🇧 Великобритания 2`,
  `hysteria2://pass123@uk3.example.com:443,8443?sni=uk3.example.com#🇬🇧 Великобритания 3`,
  `vless://${id}@uk4.example.com:443?type=httpupgrade&security=tls&sni=uk4.example.com&host=uk4.example.com&path=%2Fup#🇬🇧 Великобритания 4`,
  `vless://${id}@uk5.example.com:443?type=ws&security=tls&sni=uk5.example.com&host=uk5.example.com&path=%2Fws&foo=bar#🇬🇧 Великобритания 5`
];

const body = Buffer.from(links.join('\n'), 'utf8').toString('base64');
const target = process.argv[2] || new URL('./subscription-3xui.txt', import.meta.url);
writeFileSync(target, body);
console.log(`wrote ${links.length} links, ${body.length} bytes to ${target}`);
if (process.argv.includes('--raw')) console.log(readFileSync(target, 'utf8'));
