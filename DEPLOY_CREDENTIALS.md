# Deployment Credentials

## Production Server
- **Host:** `156.67.105.64`
- **User:** `root`
- **Password:** `30rZNitUz*un6vgz`
- **Port:** `22`

## GitHub Actions Secrets (Repository: Adelphos-tech/Autobug)
| Secret Name      | Value                                    |
|------------------|------------------------------------------|
| `SSH_HOST`       | `156.67.105.64`                          |
| `SSH_USER`       | `root`                                   |
| `SSH_PORT`       | `22`                                     |
| `SSH_PASSWORD`   | `30rZNitUz*un6vgz`                       |
| `DATABASE_URL`   | (set on server `.env`, not in CI)      |

## SSH Keys (Local)
- **Original ed25519 key:** `.ssh/autobug_deploy`
- **RSA fallback key:** `.ssh/autobug_deploy_go_pkcs1.pem`
- **Public key (both added to server):**
  - `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJhGDVjMHToyfMbS/+YHbXf3TnKTrAkRtSBcb/zlkrfs autobug-deploy@adelphostech.com`
  - `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCjmI4IMqAZef7FUPbm3RsvmpSZHRen8azOVI+o2eYUaWvfxGsHHzjHRggnENEvKtUIK8kXlp2JCmhVygqgGRrHBeoSMgfWcpMloE0NwELXbbYAIzRXhGhSTNgHoT/hIM+F0k/u4FYUoaHDPtyeQs3oot6cOUgAwgT7j6jU0ptdb87bbyj4UN0KDR3aNIbF8zwDwtNurkgwZmv+Y8lhpJKTrosGlr7yLt/Y/IOMZdwunH2169+Ccrso0K92sLpDIgNEL02k4nBrySg4Yk+uwIXnra0cSwps+aYprhSMRsRCgF7A+lOnhcOV91slUVuz7XVWn6LsXzO+O6R+bBCk1oWoNWNn9Tz8hCic7iS1RHoUenbBR4e5jbLFmC0eX1sUCcmGHJbXNugKQmeQ2IUaGjRZBxCzhctL5UjxqwBs2Q3BHcQ6uz4twwOrcjFPJlMT8ms3vGwegUSLdH6+nzj+50M8W2VjUD/kaREiJ9EcIjJ4hTchF3rxyQXNXBJ7vLnzlUBlrzitmpc5NnFI23IfPe4VcHPQefSyUDkOGVIK7/JMtV56h2IwK/pmIutjoTBmhS8tnXa7l1CPLGVRy+cBrDkvX7Zx9ZFXKNVdHC8nXchVBaPttDYFMU8cUSbapnJNfTTmmI05BDrQ2+zxs++DshYisAYeXAMglKl+1bMuQQOw9Q==`

## Deployment Path on Server
`/opt/autobug/`

## Systemd Services
- `autobug-server`
- `autobug-worker`
