const bcrypt = require('bcrypt');
const readline = require('readline');
const db = require('../db');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => resolve(answer.trim()));
    });
}

function askHidden(question) {
    return new Promise(resolve => {
        process.stdout.write(question);

        let password = '';

        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        function onData(char) {
            if (char === '\u0003') {
                stdin.setRawMode(false);
                stdin.pause();
                process.stdout.write('\n');
                process.exit(1);
            }

            if (char === '\r' || char === '\n') {
                stdin.removeListener('data', onData);
                stdin.setRawMode(false);
                stdin.pause();
                process.stdout.write('\n');
                resolve(password);
                return;
            }

            if (char === '\u007f' || char === '\b') {
                password = password.slice(0, -1);
                return;
            }

            if (char >= ' ') {
                password += char;
            }
        }

        stdin.on('data', onData);
    });
}

async function createSystemOwner() {
    try {
        const fullName = await ask('System owner full name: ');
        const email = (await ask('System owner email: ')).toLowerCase();

        const password = await askHidden(
            'Create password (minimum 12 characters): '
        );

        if (!fullName || !email || !password) {
            throw new Error('All fields are required.');
        }

        if (password.length < 12) {
            throw new Error(
                'Password must contain at least 12 characters.'
            );
        }

        const [existing] = await db.execute(
            'SELECT id FROM system_owners WHERE email = ? LIMIT 1',
            [email]
        );

        if (existing.length > 0) {
            throw new Error(
                'A system owner with this email already exists.'
            );
        }

        const passwordHash = await bcrypt.hash(password, 12);

        await db.execute(
            `INSERT INTO system_owners
                (full_name, email, password_hash)
             VALUES (?, ?, ?)`,
            [fullName, email, passwordHash]
        );

        console.log('\nSystem Owner account created successfully.');
        console.log(`Email: ${email}`);
        console.log('Keep your password private.');

    } catch (error) {
        console.error('\nCould not create System Owner:', error.message);
        process.exitCode = 1;
    } finally {
        rl.close();
        await db.end();
    }
}

createSystemOwner();