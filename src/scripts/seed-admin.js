#!/usr/bin/env node
/**
 * Seed Admin Account — AutoBug Multi-Vendor SaaS
 * 
 * Creates:
 *  1. Default "Adelphos Tech" vendor
 *  2. Admin user (shivang@adelphos.tech)
 *  3. Migrates existing tickets to the default vendor
 * 
 * Usage: node src/scripts/seed-admin.js [--password <password>]
 */

require('dotenv').config();
const prisma = require('../services/prismaClient');

async function seed() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       AUTOBUG — Admin Account Seed Script            ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // Parse --password flag
  const args = process.argv.slice(2);
  const pwIndex = args.indexOf('--password');
  let adminPassword = pwIndex !== -1 && args[pwIndex + 1] ? args[pwIndex + 1] : null;

  if (!adminPassword) {
    adminPassword = authService.generateComplexPassword(20);
  }

  try {
    // ── 1. Create default vendor ──
    const vendorSlug = 'adelphos-tech';
    let vendor = await prisma.vendor.findUnique({ where: { slug: vendorSlug } });

    if (!vendor) {
      vendor = await prisma.vendor.create({
        data: {
          id: crypto.randomUUID(),
          name: 'Adelphos Tech',
          slug: vendorSlug,
          isActive: true,
        },
      });
      console.log(`✅ Created default vendor: "${vendor.name}" (${vendor.id})`);

      // Create VendorConfig for Adelphos Tech
      await prisma.vendorConfig.create({
        data: {
          id: crypto.randomUUID(),
          vendorId: vendor.id,
          repoPath: '/var/www/adelphos_frontend',
          sshHost: process.env.SSH_HOST || '156.67.105.64',
          sshUser: process.env.SSH_USER || 'root',
        },
      });
      console.log(`   ⚙️  Created vendor config (repo: /var/www/adelphos_frontend)`);
    } else {
      console.log(`ℹ️  Default vendor already exists: "${vendor.name}" (${vendor.id})`);
    }

    // ── 2. Create or update admin user ──
    const adminEmail = 'shivang@adelphos.tech';
    const passwordHash = await authService.hashPassword(adminPassword);

    let admin = await prisma.user.findUnique({ where: { email: adminEmail } });

    if (admin) {
      admin = await prisma.user.update({
        where: { email: adminEmail },
        data: {
          passwordHash,
          role: 'ADMIN',
          vendorId: vendor.id,
          isActive: true,
          name: 'Shivang',
        },
      });
      console.log(`✅ Updated admin user: ${admin.email} (password reset)`);
    } else {
      admin = await prisma.user.create({
        data: {
          id: 'admin-' + crypto.randomUUID().substring(0, 8),
          email: adminEmail,
          passwordHash,
          name: 'Shivang',
          role: 'ADMIN',
          vendorId: vendor.id,
          isActive: true,
        },
      });
      console.log(`✅ Created admin user: ${admin.email}`);
    }

    // ── 3. Migrate existing tickets to default vendor ──
    const unassignedTickets = await prisma.ticket.count({ where: { vendorId: null } });
    if (unassignedTickets > 0) {
      await prisma.ticket.updateMany({
        where: { vendorId: null },
        data: { vendorId: vendor.id },
      });
      console.log(`✅ Migrated ${unassignedTickets} existing ticket(s) to "${vendor.name}"`);
    }

    // ── 4. Migrate existing users to default vendor ──
    const unassignedUsers = await prisma.user.count({ where: { vendorId: null } });
    if (unassignedUsers > 0) {
      await prisma.user.updateMany({
        where: { vendorId: null },
        data: { vendorId: vendor.id },
      });
      console.log(`✅ Migrated ${unassignedUsers} existing user(s) to "${vendor.name}"`);
    }

    // ── Output credentials ──
    console.log('\n' + '═'.repeat(60));
    console.log('  ADMIN CREDENTIALS (save these securely!)');
    console.log('═'.repeat(60));
    console.log(`  Email:    ${adminEmail}`);
    console.log(`  Password: ${adminPassword}`);
    console.log(`  Role:     ADMIN`);
    console.log(`  Vendor:   ${vendor.name}`);
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
