const fs = require('fs');
const path = require('path');

const serviceNames = [
  'userService', 'friendService', 'friendRequestService', 'blockService',
  'serverService', 'channelService', 'messageService', 'dmService',
  'dmMessageService', 'inviteService', 'discoveryService', 'adminLogService',
  'adminService', 'fileService', 'reactionService', 'pinnedMessageService',
  'callLogService', 'categoryService', 'systemMessageService', 'botService'
];

const serviceNamesJoined = serviceNames.join('|');
const checkPattern = new RegExp('(' + serviceNamesJoined + ')\\.\\w+\\(');
const awaitCheck = new RegExp('await\\s+(' + serviceNamesJoined + ')\\.');
const replacePattern = new RegExp('(?<!await )\\b(' + serviceNamesJoined + ')\\.', 'g');

const routeDir = path.join(__dirname, '..', 'routes');
const routeFiles = fs.readdirSync(routeDir).filter(f => f.endsWith('.js')).map(f => path.join(routeDir, f));

const serviceDir = path.join(__dirname, '..', 'services');
const extraServiceFiles = ['socketService.js']
  .filter(f => fs.existsSync(path.join(serviceDir, f)))
  .map(f => path.join(serviceDir, f));

const allFiles = [...routeFiles, ...extraServiceFiles];

let totalChanges = 0;

for (const filePath of allFiles) {
  const file = path.basename(filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  let changes = 0;

  const lines = content.split('\n');
  const newLines = lines.map((line) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return line;
    if (!checkPattern.test(line)) return line;
    
    // Already has await
    if (awaitCheck.test(line)) return line;

    const newLine = line.replace(replacePattern, 'await $1.');
    if (newLine !== line) {
      changes++;
      totalChanges++;
    }
    return newLine;
  });

  if (changes > 0) {
    let newContent = newLines.join('\n');

    // Ensure route handlers are async
    // (req, res) => { -> async (req, res) => {
    newContent = newContent.replace(/(?<!async )\(req, res\) => \{/g, 'async (req, res) => {');
    newContent = newContent.replace(/(?<!async )\(req, res, next\) => \{/g, 'async (req, res, next) => {');

    fs.writeFileSync(filePath, newContent);
    console.log(file + ': ' + changes + ' await(s) added');
  } else {
    console.log(file + ': no changes needed');
  }
}

console.log('Total changes: ' + totalChanges);
