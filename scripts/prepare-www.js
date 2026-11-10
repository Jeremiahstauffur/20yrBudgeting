const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const wwwDir = path.join(rootDir, 'www');
const androidAssetsPublic = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'public');

function copyRecursive(src, dest) {
    if (!fs.existsSync(src)) return;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const item of fs.readdirSync(src)) {
            copyRecursive(path.join(src, item), path.join(dest, item));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

function bundleAssetsTo(targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const startHtml = path.join(rootDir, 'start.html');
    fs.copyFileSync(startHtml, path.join(targetDir, 'start.html'));
    fs.copyFileSync(startHtml, path.join(targetDir, 'index.html'));
    copyRecursive(path.join(rootDir, 'js'), path.join(targetDir, 'js'));
    copyRecursive(path.join(rootDir, 'lib'), path.join(targetDir, 'lib'));
    copyRecursive(path.join(rootDir, 'css'), path.join(targetDir, 'css'));
}

bundleAssetsTo(wwwDir);
bundleAssetsTo(androidAssetsPublic);
console.log('Bundled web assets into www/ and android/app/src/main/assets/public/');
