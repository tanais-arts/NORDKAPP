// Test de validation des URLs photos et vidéos
const TEST_MODE = true;

async function validateAssets() {
  console.log('🔍 Validation des assets NORDKAPP...\n');
  
  try {
    // Charger les données
    const [photos, travel] = await Promise.all([
      fetch('photos.json').then(r => r.json()),
      fetch('travel.json').then(r => r.json())
    ]);
    
    console.log(`📸 Photos à tester: ${photos.length}`);
    console.log(`🎥 Vidéos à tester: ${travel.length}\n`);
    
    // Tester quelques photos (les 5 premières)
    const photoTests = photos.slice(0, 5);
    for (const photo of photoTests) {
      const thumbUrl = photo.thumb || photo.src;
      const webpUrl = photo.webp;
      
      console.log(`Testing: ${thumbUrl.split('/').pop()}`);
      
      // Test thumb
      const thumbResponse = await fetch(thumbUrl, { method: 'HEAD' });
      console.log(`  Thumb: ${thumbResponse.ok ? '✅' : '❌'} (${thumbResponse.status})`);
      
      // Test WebP si disponible
      if (webpUrl) {
        const webpResponse = await fetch(webpUrl, { method: 'HEAD' });
        console.log(`  WebP:  ${webpResponse.ok ? '✅' : '❌'} (${webpResponse.status})`);
      }
    }
    
    console.log('\n🎥 Test de quelques vidéos...');
    const videoTests = travel.slice(0, 3);
    for (const entry of videoTests) {
      const videoName = entry.url.split('/').pop();
      console.log(`Testing: ${videoName}`);
      
      const videoResponse = await fetch(entry.url, { method: 'HEAD' });
      console.log(`  Video: ${videoResponse.ok ? '✅' : '❌'} (${videoResponse.status})`);
    }
    
    console.log('\n✅ Tests terminés!');
  } catch (err) {
    console.error('❌ Erreur:', err);
  }
}

// Lancer si en mode test
if (TEST_MODE) {
  validateAssets();
}
