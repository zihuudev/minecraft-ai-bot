const Discord = require('discord.js');
const express = require('express');
const path = require('path');

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMembers
    ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// Bot configuration
const config = {
    token: process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN',
    prefix: '!',
    updateChannelId: process.env.UPDATE_CHANNEL_ID || 'YOUR_UPDATE_CHANNEL_ID',
    adminRoleId: process.env.ADMIN_ROLE_ID || 'YOUR_ADMIN_ROLE_ID'
};

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

// Express setup for dashboard
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Bot Dashboard</title>
        <style>
            body { font-family: Arial, sans-serif; background: #2c2f33; color: white; margin: 0; padding: 20px; }
            .container { max-width: 800px; margin: 0 auto; }
            .card { background: #36393f; padding: 20px; margin: 20px 0; border-radius: 8px; }
            button { background: #7289da; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
            button:hover { background: #5b6eae; }
            input, textarea { width: 100%; padding: 10px; margin: 10px 0; background: #40444b; border: 1px solid #555; color: white; border-radius: 5px; }
            .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
            .success { background: #43b581; }
            .error { background: #f04747; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Bot Dashboard</h1>
            
            <div class="card">
                <h2>Bot Status</h2>
                <p>Status: <span style="color: #43b581;">Online</span></p>
                <p>Servers: ${client.guilds.cache.size}</p>
                <p>Users: ${client.users.cache.size}</p>
            </div>

            <div class="card">
                <h2>Update System</h2>
                <textarea id="updateMessage" placeholder="Update message..." rows="4"></textarea>
                <br>
                <button onclick="sendUpdate()">Send Update</button>
                <button onclick="lockChannel()">Lock Update Channel</button>
                <button onclick="unlockChannel()">Unlock Update Channel</button>
                <div id="updateStatus"></div>
            </div>

            <div class="card">
                <h2>Quick Actions</h2>
                <button onclick="restartBot()">Restart Bot</button>
                <button onclick="clearCache()">Clear Cache</button>
            </div>
        </div>

        <script>
            async function sendUpdate() {
                const message = document.getElementById('updateMessage').value;
                if (!message) {
                    showStatus('Please enter update message!', 'error');
                    return;
                }
                
                try {
                    const response = await fetch('/api/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message })
                    });
                    
                    if (response.ok) {
                        showStatus('Update sent successfully!', 'success');
                        document.getElementById('updateMessage').value = '';
                    } else {
                        showStatus('Failed to send update!', 'error');
                    }
                } catch (error) {
                    showStatus('Error: ' + error.message, 'error');
                }
            }

            async function lockChannel() {
                try {
                    const response = await fetch('/api/lock-channel', { method: 'POST' });
                    if (response.ok) {
                        showStatus('Channel locked successfully!', 'success');
                    } else {
                        showStatus('Failed to lock channel!', 'error');
                    }
                } catch (error) {
                    showStatus('Error: ' + error.message, 'error');
                }
            }

            async function unlockChannel() {
                try {
                    const response = await fetch('/api/unlock-channel', { method: 'POST' });
                    if (response.ok) {
                        showStatus('Channel unlocked successfully!', 'success');
                    } else {
                        showStatus('Failed to unlock channel!', 'error');
                    }
                } catch (error) {
                    showStatus('Error: ' + error.message, 'error');
                }
            }

            function showStatus(message, type) {
                const statusDiv = document.getElementById('updateStatus');
                statusDiv.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
                setTimeout(() => statusDiv.innerHTML = '', 5000);
            }

            async function restartBot() {
                if (confirm('Are you sure you want to restart the bot?')) {
                    await fetch('/api/restart', { method: 'POST' });
                    showStatus('Bot restarting...', 'success');
                }
            }

            async function clearCache() {
                await fetch('/api/clear-cache', { method: 'POST' });
                showStatus('Cache cleared!', 'success');
            }
        </script>
    </body>
    </html>
    `);
});

// API endpoints
app.post('/api/update', async (req, res) => {
    try {
        const { message } = req.body;
        const channel = client.channels.cache.get(config.updateChannelId);
        
        if (!channel) {
            return res.status(404).json({ error: 'Update channel not found' });
        }

        const embed = new Discord.EmbedBuilder()
            .setTitle('🔄 Bot Update')
            .setDescription(message)
            .setColor('#FFD700')
            .setFooter({ text: 'Premium Bot Update System' })
            .setTimestamp();

        await channel.send({ content: '@everyone', embeds: [embed] });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/lock-channel', async (req, res) => {
    try {
        const channel = client.channels.cache.get(config.updateChannelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: false
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/unlock-channel', async (req, res) => {
    try {
        const channel = client.channels.cache.get(config.updateChannelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: true
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bot commands
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'help':
                const helpEmbed = new Discord.EmbedBuilder()
                    .setTitle('🎮 Minecraft Bot Commands')
                    .setDescription('Here are all available commands:')
                    .addFields(
                        { name: '🧱 Block Commands', value: '`!block` - Random block info\n`!blocks` - List all blocks', inline: true },
                        { name: '⚔️ Item Commands', value: '`!item` - Random item info\n`!items` - List all items', inline: true },
                        { name: '👾 Mob Commands', value: '`!mob` - Random mob info\n`!mobs` - List all mobs', inline: true },
                        { name: '🌍 World Commands', value: '`!biome` - Random biome info\n`!biomes` - List all biomes', inline: true },
                        { name: '🔨 Crafting', value: '`!recipe <item>` - Get crafting recipe\n`!recipes` - List all recipes', inline: true },
                        { name: '🎲 Fun Commands', value: '`!random` - Random minecraft fact\n`!quiz` - Minecraft quiz', inline: true }
                    )
                    .setColor('#00FF00')
                    .setFooter({ text: 'Minecraft Expert Bot' });
                
                await message.reply({ embeds: [helpEmbed] });
                break;

            case 'block':
                const randomBlock = minecraftData.blocks[Math.floor(Math.random() * minecraftData.blocks.length)];
                const blockEmbed = new Discord.EmbedBuilder()
                    .setTitle(`🧱 ${randomBlock}`)
                    .setDescription(`This is a ${randomBlock.toLowerCase()} block in Minecraft!`)
                    .setColor('#8B4513')
                    .setFooter({ text: 'Minecraft Blocks' });
                
                await message.reply({ embeds: [blockEmbed] });
                break;

            case 'blocks':
                const blocksEmbed = new Discord.EmbedBuilder()
                    .setTitle('🧱 All Minecraft Blocks')
                    .setDescription(minecraftData.blocks.join(', '))
                    .setColor('#8B4513');
                
                await message.reply({ embeds: [blocksEmbed] });
                break;

            case 'item':
                const randomItem = minecraftData.items[Math.floor(Math.random() * minecraftData.items.length)];
                const itemEmbed = new Discord.EmbedBuilder()
                    .setTitle(`⚔️ ${randomItem}`)
                    .setDescription(`This is a ${randomItem.toLowerCase()} in Minecraft!`)
                    .setColor('#FFD700')
                    .setFooter({ text: 'Minecraft Items' });
                
                await message.reply({ embeds: [itemEmbed] });
                break;

            case 'items':
                const itemsEmbed = new Discord.EmbedBuilder()
                    .setTitle('⚔️ All Minecraft Items')
                    .setDescription(minecraftData.items.join(', '))
                    .setColor('#FFD700');
                
                await message.reply({ embeds: [itemsEmbed] });
                break;

            case 'mob':
                const randomMob = minecraftData.mobs[Math.floor(Math.random() * minecraftData.mobs.length)];
                const mobEmbed = new Discord.EmbedBuilder()
                    .setTitle(`👾 ${randomMob}`)
                    .setDescription(`This is a ${randomMob.toLowerCase()} mob in Minecraft!`)
                    .setColor('#FF4500')
                    .setFooter({ text: 'Minecraft Mobs' });
                
                await message.reply({ embeds: [mobEmbed] });
                break;

            case 'mobs':
                const mobsEmbed = new Discord.EmbedBuilder()
                    .setTitle('👾 All Minecraft Mobs')
                    .setDescription(minecraftData.mobs.join(', '))
                    .setColor('#FF4500');
                
                await message.reply({ embeds: [mobsEmbed] });
                break;

            case 'biome':
                const randomBiome = minecraftData.biomes[Math.floor(Math.random() * minecraftData.biomes.length)];
                const biomeEmbed = new Discord.EmbedBuilder()
                    .setTitle(`🌍 ${randomBiome}`)
                    .setDescription(`This is the ${randomBiome.toLowerCase()} biome in Minecraft!`)
                    .setColor('#32CD32')
                    .setFooter({ text: 'Minecraft Biomes' });
                
                await message.reply({ embeds: [biomeEmbed] });
                break;

            case 'biomes':
                const biomesEmbed = new Discord.EmbedBuilder()
                    .setTitle('🌍 All Minecraft Biomes')
                    .setDescription(minecraftData.biomes.join(', '))
                    .setColor('#32CD32');
                
                await message.reply({ embeds: [biomesEmbed] });
                break;

            case 'recipe':
                const itemName = args.join('_').toLowerCase();
                const recipe = minecraftData.recipes[itemName];
                
                if (recipe) {
                    const recipeEmbed = new Discord.EmbedBuilder()
                        .setTitle(`🔨 ${itemName.replace('_', ' ').toUpperCase()} Recipe`)
                        .setDescription(`**Recipe:** ${recipe}`)
                        .setColor('#FF6347')
                        .setFooter({ text: 'Minecraft Crafting' });
                    
                    await message.reply({ embeds: [recipeEmbed] });
                } else {
                    await message.reply('❌ Recipe not found! Use `!recipes` to see available recipes.');
                }
                break;

            case 'recipes':
                const recipeList = Object.keys(minecraftData.recipes).map(item => 
                    `**${item.replace('_', ' ')}:** ${minecraftData.recipes[item]}`
                ).join('\n');
                
                const recipesEmbed = new Discord.EmbedBuilder()
                    .setTitle('🔨 All Minecraft Recipes')
                    .setDescription(recipeList)
                    .setColor('#FF6347');
                
                await message.reply({ embeds: [recipesEmbed] });
                break;

            case 'random':
                const facts = [
                    'Creepers were created by accident!',
                    'The Ender Dragon is female and her name is Jean!',
                    'Minecraft has sold over 200 million copies!',
                    'The first version was created in just 6 days!',
                    'Ghasts make cat-like sounds!',
                    'Endermen are scared of water!',
                    'Pigs can be struck by lightning to become Zombie Pigmen!',
                    'Diamonds are most common at Y-level 12!'
                ];
                
                const randomFact = facts[Math.floor(Math.random() * facts.length)];
                const factEmbed = new Discord.EmbedBuilder()
                    .setTitle('🎲 Random Minecraft Fact')
                    .setDescription(randomFact)
                    .setColor('#9932CC')
                    .setFooter({ text: 'Did you know?' });
                
                await message.reply({ embeds: [factEmbed] });
                break;

            case 'quiz':
                const questions = [
                    { q: 'What do you need to make a Nether Portal?', a: 'Obsidian' },
                    { q: 'How many blocks of iron do you need for a full set of iron armor?', a: '24' },
                    { q: 'What dimension do Endermen come from?', a: 'The End' },
                    { q: 'What food item restores the most hunger?', a: 'Golden Carrot' }
                ];
                
                const randomQ = questions[Math.floor(Math.random() * questions.length)];
                const quizEmbed = new Discord.EmbedBuilder()
                    .setTitle('🧠 Minecraft Quiz')
                    .setDescription(`**Question:** ${randomQ.q}`)
                    .setFooter({ text: 'Answer in chat!' })
                    .setColor('#4169E1');
                
                await message.reply({ embeds: [quizEmbed] });
                
                // Wait for answer
                const filter = m => m.author.id === message.author.id;
                const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });
                
                collector.on('collect', m => {
                    if (m.content.toLowerCase().includes(randomQ.a.toLowerCase())) {
                        m.reply('✅ Correct! Well done!');
                    } else {
                        m.reply(`❌ Wrong! The correct answer was: ${randomQ.a}`);
                    }
                });
                
                collector.on('end', collected => {
                    if (collected.size === 0) {
                        message.channel.send('⏰ Time\'s up! No answer received.');
                    }
                });
                break;

            case 'ping':
                const ping = Date.now() - message.createdTimestamp;
                const pingEmbed = new Discord.EmbedBuilder()
                    .setTitle('🏓 Pong!')
                    .setDescription(`Bot Latency: ${ping}ms\nAPI Latency: ${Math.round(client.ws.ping)}ms`)
                    .setColor('#00FFFF');
                
                await message.reply({ embeds: [pingEmbed] });
                break;

            case 'info':
                const infoEmbed = new Discord.EmbedBuilder()
                    .setTitle('🤖 Bot Information')
                    .setDescription('Advanced Minecraft Discord Bot')
                    .addFields(
                        { name: 'Servers', value: client.guilds.cache.size.toString(), inline: true },
                        { name: 'Users', value: client.users.cache.size.toString(), inline: true },
                        { name: 'Uptime', value: formatUptime(client.uptime), inline: true }
                    )
                    .setColor('#7289DA')
                    .setFooter({ text: 'Made with ❤️' });
                
                await message.reply({ embeds: [infoEmbed] });
                break;

            default:
                await message.reply('❌ Unknown command! Use `!help` to see all commands.');
        }
    } catch (error) {
        console.error('Command error:', error);
        await message.reply('❌ An error occurred while executing the command!');
    }
});

// Helper functions
function formatUptime(uptime) {
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// Bot events
client.on('ready', () => {
    console.log(`✅ Bot is online as ${client.user.tag}`);
    client.user.setActivity('Minecraft | !help', { type: Discord.ActivityType.Playing });
});

client.on('error', console.error);

// Start server and bot
app.listen(PORT, () => {
    console.log(`🌐 Dashboard running on port ${PORT}`);
});

client.login(config.token);

// Keep alive for free hosting
setInterval(() => {
    console.log('Bot is alive!');
}, 300000); // 5 minutes
