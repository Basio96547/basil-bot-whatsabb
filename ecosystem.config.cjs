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
      // بند 9، نقطة 4 — سقف يمنع تسرّب ذاكرة من ابتلاع الجوال. كان 200M،
      // وقياس فعلي على الجهاز (2026-08-22) أظهر أن الاستهلاك الطبيعي بعد
      // تحميل جلسة Baileys يتجاوزه خلال دقيقتين من الإقلاع — فصار pm2 يقتل
      // الخدمة كل دقيقتين، وكل قتلة تعني إعادة اتصال واتساب من جديد. إعادة
      // اتصال متكررة على عميل غير رسمي هي بالضبط ما يرفع خطر حظر الرقم، أي
      // أن الحد كان يصنع الضرر الذي وُضع ليمنعه. 400M يترك هامشاً للتشغيل
      // الطبيعي ويظل يمسك أي تسرّب حقيقي.
      max_memory_restart: '400M',
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
