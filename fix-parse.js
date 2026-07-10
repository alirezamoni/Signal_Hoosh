const fs = require('fs');

function parseFA(text) {
  if (!text) return { vol: 0, growth: 0 };
  
  // Extract volume: "۵ هزار+" → 5000, "۲۰۰+" → 200, "۱ میلیون+" → 1000000
  const volMatch = text.match(/([\d۰-۹٬]+)\s*(هزار|میلیون)?/);
  let vol = 0;
  if (volMatch) {
    const num = parseInt(volMatch[1].replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٬/g,''));
    const unit = volMatch[2];
    vol = unit === 'هزار' ? num * 1000 : unit === 'میلیون' ? num * 1000000 : num;
  }
  
  // Extract growth: "۱٬۰۰۰٪" → 1000, "۵۰۰٪" → 500
  const grMatch = text.match(/([\d۰-۹٬]+)٪/);
  let growth = 0;
  if (grMatch) {
    growth = parseInt(grMatch[1].replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٬/g,''));
  }
  
  return { vol, growth };
}

// Fix h4.json
['h4','h24'].forEach(key => {
  const file = `/opt/signal/data/${key}.json`;
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  data.trends = data.trends.map(t => {
    const parsed = parseFA(t.unit || '');
    return {
      ...t,
      vol: parsed.vol || t.vol,
      growth: parsed.growth || t.growth,
      unit: parsed.vol >= 1000000 ? 'M+' : parsed.vol >= 1000 ? 'K+' : '+',
      time: '',
    };
  });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Fixed ${key}: ${data.trends.length} trends`);
});
