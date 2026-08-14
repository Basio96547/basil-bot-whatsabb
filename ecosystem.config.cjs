// pm2 start ecosystem.config.cjs   (بند 8، طبقة 2: يرجّع العملية تلقائياً لو انهارت)
// pm2 save                        (يحفظ القائمة عشان pm2 resurrect تشتغل بعد إعادة الإقلاع)
module.exports = {
  apps: [
    {
      name: 'sms-api',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: '200M', // بند 9، نقطة 4 — سقف مناسب لجوال
      env: { NODE_ENV: 'production' },
    },
    {
      // بدون هذا التونيل، ووركر المتجر ما يقدر يوصل للخدمة أصلاً — الجوال
      // عادةً بلا IP عام (خصوصاً على نت الموبايل). راجع README قسم الشبكة.
      name: 'cloudflared-tunnel',
      script: 'cloudflared',
      args: 'tunnel run sms-api',
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
