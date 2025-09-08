const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const express = require('express');

// Bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const config = {
    token: process.env.BOT_TOKEN,
    prefix: '!',
    updateChannelId: process.env.UPDATE_CHANNEL_ID,
    adminRoleId: process.env.ADMIN_ROLE_ID
};

// Check if token exists
if (!config.token) {
    console.error('❌ BOT_TOKEN not found in environment variables!');
    process.exit(1);
}

// Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Keep alive endpoint
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Minecraft Bot Dashboard</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white; 
                min-height: 100vh;
                padding: 20px;
            }
            .container { 
                max-width: 1200px; 
                margin: 0 auto; 
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 30px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            }
            .header {
                text-align: center;
                margin-bottom: 40px;
            }
            .header h1 {
                font-size: 3em;
                margin-bottom: 10px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
            }
            .status-card {
                background: rgba(255,255,255,0.2);
                padding: 25px;
                border-radius: 15px;
                margin: 20px 0;
                border: 1px solid rgba(255,255,255,0.3);
            }
            .status-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin: 20px 0;
            }
            .stat-item {
                text-align: center;
                padding: 20px;
                background: rgba(255,255,255,0.1);
                border-radius: 10px;
            }
            .stat-number {
                font-size: 2em;
                font-weight: bold;
                color: #4CAF50;
            }
            .control-panel {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 20px;
                margin: 30px 0;
            }
            .control-card {
                background: rgba(255,255,255,0.15);
                padding: 25px;
                border-radius: 15px;
                border: 1px solid rgba(255,255,255,0.2);
            }
            button {
                background: linear-gradient(45deg, #4CAF50, #45a049);
                color: white;
                border: none;
                padding: 12px 25px;
                border-radius: 25px;
                cursor: pointer;
                margin: 8px;
                font-size: 14px;
                font-weight: bold;
                transition: all 0.3s ease;
                box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            }
            button:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(0,0,0,0.3);
            }
            .danger { background: linear-gradient(45deg, #f44336, #d32f2f); }
            .warning { background: linear-gradient(45deg, #ff9800, #f57c00); }
            textarea {
                width: 100%;
                padding: 15px;
                margin: 15px 0;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.3);
                color: white;
                border-radius: 10px;
                resize: vertical;
                font-family: inherit;
            }
            textarea::placeholder { color: rgba(255,255,255,0.7); }
            .status-message {
                padding: 15px;
                margin: 15px 0;
                border-radius: 10px;
                font-weight: bold;
            }
            .success { background: rgba(76, 175, 80, 0.3); border: 1px solid #4CAF50; }
            .error { background: rgba(244, 67, 54, 0.3); border: 1px solid #f44336; }
            .online { color: #4CAF50; }
            .offline { color: #f44336; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎮 Minecraft Bot Dashboard</h1>
                <p>Advanced Discord Bot Control Panel</p>
            </div>

            <div class="status-card">
                <h2>📊 Bot Status</h2>
                <div class="status-grid">
                    <div class="stat-item">
                        <div class="stat-number online">●</div>
                        <div>Status: Online</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">${client.guilds ? client.guilds.cache.size : 0}</div>
                        <div>Servers</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">${client.users ? client.users.cache.size : 0}</div>
                        <div>Users</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">${client.ws ? Math.round(client.ws.ping) : 0}ms</div>
                        <div>Ping</div>
                    </div>
                </div>
            </div>

            <div class="control-panel">
                <div class="control-card">
                    <h3>🔄 Update System</h3>
                    <textarea id="updateMessage" placeholder="Enter update message..." rows="4"></textarea>
                    <button onclick="sendUpdate()">📢 Send Update</button>
                    <button onclick="lockChannel()" class="warning">🔒 Lock Channel</button>
                    <button onclick="unlockChannel()">🔓 Unlock Channel</button>
                    <div id="updateStatus"></div>
                </div>

                <div class="control-card">
                    <h3>⚡ Quick Actions</h3>
                    <button onclick="testBot()">🧪 Test Bot</button>
                    <button onclick="getStats()">📈 Refresh Stats</button>
                    <button onclick="clearLogs()">🗑️ Clear Logs</button>
                    <button onclick="restartBot()" class="danger">🔄 Restart Bot</button>
                </div>
            </div>

            <div class="status-card">
                <h3>📝 Recent Activity</h3>
                <div id="activityLog">
                    <p>✅ Bot started successfully</p>
                    <p>✅ Dashboard loaded</p>
                    <p>✅ All systems operational</p>
                </div>
            </div>
        </div>

        <script>
            async function sendUpdate() {
                const message = document.getElementById('updateMessage').value;
                if (!message.trim()) {
                    showStatus('Please enter an update message!', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message })
                    });
                    
                    const result = await response.json();
                    if (response.ok) {
                        showStatus('✅ Update sent successfully!', 'success');
                        document.getElementById('updateMessage').value = '';
                        addActivity('📢 Update message sent');
                    } else {
                        showStatus('❌ Failed: ' + result.error, 'error');
                    }
                } catch (error) {
                    showStatus('❌ Network error: ' + error.message, 'error');
                }
            }

            async function lockChannel() {
                try {
                    const response = await fetch('/api/lock-channel', { method: 'POST' });
                    const result = await response.json();
                    
                    if (response.ok) {
                        showStatus('🔒 Channel locked successfully!', 'success');
                        addActivity('🔒 Update channel locked');
                    } else {
                        showStatus('❌ Failed to lock: ' + result.error, 'error');
                    }
                } catch (error) {
                    showStatus('❌ Error: ' + error.message, 'error');
                }
            }

            async function unlockChannel() {
                try {
                    const response = await fetch('/api/unlock-channel', { method: 'POST' });
                    const result = await response.json();
                    
                    if (response.ok) {
                        showStatus('🔓 Channel unlocked successfully!', 'success');
                        addActivity('🔓 Update channel unlocked');
                    } else {
                        showStatus('❌ Failed to unlock: ' + result.error, 'error');
                    }
                } catch (error) {
                    showStatus('❌ Error: ' + error.message, 'error');
                }
            }

            async function testBot() {
                try {
                    const response = await fetch('/api/test');
                    const result = await response.json();
                    
                    if (response.ok) {
                        showStatus('✅ Bot test successful!', 'success');
                        addActivity('🧪 Bot test completed');
                    } else {
                        showStatus('❌ Bot test failed!', 'error');
                    }
                } catch (error) {
                    showStatus('❌ Test failed: ' + error.message, 'error');
                }
            }

            function showStatus(message, type) {
                const statusDiv = document.getElementById('updateStatus');
                statusDiv.innerHTML = '<div class="status-message ' + type + '">' + message + '</div>';
                setTimeout(() => statusDiv.innerHTML = '', 5000);
            }

            function addActivity(message) {
                const log = document.getElementById('activityLog');
                const time = new Date().toLocaleTimeString();
                log.innerHTML = '<p>🕐 ' + time + ' - ' + message + '</p>' + log.innerHTML;
            }

            function restartBot() {
                if (confirm('Are you sure you want to restart the bot?')) {
                    showStatus('🔄 Restarting bot...', 'success');
                    addActivity('🔄 Bot restart initiated');
                }
            }

            function getStats() {
                location.reload();
            }

            function clearLogs() {
                document.getElementById('activityLog').innerHTML = '<p>✅ Logs cleared</p>';
                showStatus('🗑️ Logs cleared successfully!', 'success');
            }

            // Auto-refresh stats every 30 seconds
            setInterval(() => {
                fetch('/api/stats').then(r => r.json()).then(data => {
                    console.log('Stats updated:', data);
                }).catch(e => console.log('Stats update failed'));
            }, 30000);
        </script>
    </body>
    </html>
    `);
});

// API Routes
app.post('/api/update', async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!config.updateChannelId) {
            return res.status(400).json({ error: 'Update channel not configured' });
        }

        const channel = client.channels.cache.get(config.updateChannelId);
        if (!channel) {
            return res.status(404).json({ error: 'Update channel not found' });
        }

        const embed = new EmbedBuilder()
            .setTitle('🔄 Bot Update')
            .setDescription(message)
            .setColor('#FFD700')
            .setFooter({ text: 'Premium Bot Update System' })
            .setTimestamp();

        await channel.send({ content: '@everyone', embeds: [embed] });
        res.json({ success: true, message: 'Update sent successfully' });
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/lock-channel', async (req, res) => {
    try {
        if (!config.updateChannelId) {
            return res.status(400).json({ error: 'Update channel not configured' });
        }

        const channel = client.channels.cache.get(config.updateChannelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: false
        });

        res.json({ success: true, message: 'Channel locked successfully' });
    } catch (error) {
        console.error('Lock error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/unlock-channel', async (req, res) => {
    try {
        if (!config.updateChannelId) {
            return res.status(400).json({ error: 'Update channel not configured' });
        }

        const channel = client.channels.cache.get(config.updateChannelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: true
        });

        res.json({ success: true, message: 'Channel unlocked successfully' });
    } catch (error) {
        console.error('Unlock error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/test', (req, res) => {
    res.json({ 
        success: true, 
        status: 'Bot is running',
        uptime: process.uptime(),
        guilds: client.guilds.cache.size,
        users: client.users.cache.size
    });
});

app.get('/api/stats', (req, res) => {
    res.json({
        guilds: client.guilds.cache.size,
        users: client.users.cache.size,
        ping: client.ws.ping,
        uptime: process.uptime()
    });
});

// Minecraft data
const minecraftData = {
    blocks: ['Stone', 'Dirt', 'Grass Block', 'Cobblestone', 'Wood Planks', 'Diamond Ore', 'Iron Ore', 'Gold Ore', 'Coal Ore', 'Redstone Ore'],
    items: ['Diamond Sword', 'Iron Pickaxe', 'Bow', 'Arrow', 'Bread', 'Cooked Beef', 'Potion', 'Enchanted Book', 'Ender Pearl', 'Blaze Rod'],
    mobs: ['Zombie', 'Skeleton', 'Creeper', 'Spider', 'Enderman', 'Witch', 'Villager', 'Iron Golem', 'Dragon', 'Wither'],
    biomes: ['Plains', 'Forest', 'Desert', 'Mountains', 'Ocean', 'Jungle', 'Swamp', 'Tundra', 'Nether', 'End'],
    recipes: {
        'crafting_table': '4 Wood Planks in 2x2 pattern',
        'wooden_pickaxe': '3 Wood Planks + 2 Sticks',
        'stone_sword': '2 Cobblestone + 1 Stick',
        'bread': '3 Wheat in horizontal line',
        'chest': '8 Wood Planks around edges'
    }
};

// Bot Commands
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'help':
                const helpEmbed = new EmbedBuilder()
                    .setTitle('🎮 Minecraft Bot Commands')
                    .setDescription('Here are all available commands:')
                    .addFields(
                        { name: '🧱 Blocks', value: '`!block` - Random block\n`!blocks` - All blocks', inline: true },
                        { name: '⚔️ Items', value: '`!item` - Random item\n`!items` - All items', inline: true },
                        { name: '👾 Mobs', value: '`!mob` - Random mob\n`!mobs` - All mobs', inline: true },
                        { name: '🌍 World', value: '`!biome` - Random biome\n`!biomes` - All biomes', inline: true },
                        { name: '🔨 Crafting', value: '`!recipe <item>` - Get recipe\n`!recipes` - All recipes', inline: true },
                        { name: '🎲 Fun', value: '`!random` - Random fact\n`!quiz` - Quiz game', inline: true }
                    )
                    .setColor('#00FF00')
                    .setFooter({ text: 'Minecraft Expert Bot' });
                
                await message.reply({ embeds: [helpEmbed] });
                break;

            case 'ping':
                const ping = Date.now() - message.createdTimestamp;
                const pingEmbed = new EmbedBuilder()
                    .setTitle('🏓 Pong!')
                    .setDescription(`**Bot Latency:** ${ping}ms\n**API Latency:** ${Math.round(client.ws.ping)}ms`)
                    .setColor('#00FFFF');
                
                await message.reply({ embeds: [pingEmbed] });
                break;

            case 'block':
                const randomBlock = minecraftData.blocks[Math.floor(Math.random() * minecraftData.blocks.length)];
                const blockEmbed = new EmbedBuilder()
                    .setTitle(`🧱 ${randomBlock}`)
                    .setDescription(`This is a **${randomBlock.toLowerCase()}** block in Minecraft!`)
                    .setColor('#8B4513')
                    .setFooter({ text: 'Minecraft Blocks' });
                
                await message.reply({ embeds: [blockEmbed] });
                break;

            case 'item':
                const randomItem = minecraftData.items[Math.floor(Math.random() * minecraftData.items.length)];
                const itemEmbed = new EmbedBuilder()
                    .setTitle(`⚔️ ${randomItem}`)
                    .setDescription(`This is a **${randomItem.toLowerCase()}** in Minecraft!`)
                    .setColor('#FFD700')
                    .setFooter({ text: 'Minecraft Items' });
                
                await message.reply({ embeds: [itemEmbed] });
                break;

            default:
                await message.reply('❌ Unknown command! Use `!help` to see all commands.');
        }
    } catch (error) {
        console.error('Command error:', error);
        await message.reply('❌ An error occurred while executing the command!');
    }
});

// Bot Events
client.on('ready', () => {
    console.log(`✅ ${client.user.tag} is now online!`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    console.log(`👥 Watching ${client.users.cache.size} users`);
    
    client.user.setActivity('Minecraft | !help', { type: ActivityType.Playing });
});

client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

client.on('warn', (warning) => {
    console.warn('⚠️ Discord client warning:', warning);
});

// Process error handling
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`🌐 Dashboard running on port ${PORT}`);
    console.log(`🔗 Dashboard URL: http://localhost:${PORT}`);
});

// Login Bot
client.login(config.token).catch((error) => {
    console.error('❌ Failed to login:', error.message);
    process.exit(1);
});

// Keep alive for free hosting
setInterval(() => {
    console.log(`💓 Bot heartbeat - ${new Date().toLocaleTimeString()}`);
}, 300000); // 5 minutes
