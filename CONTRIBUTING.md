# Contributing to OzPrint

Thank you for your interest in contributing to **OzPrint**! This guide covers how to set up your development environment, run the mandatory test suite, and submit pull requests.

---

## 1. Getting Started

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/MohdFer/OzPrint.git
   cd OzPrint
   ```
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Optional — Install Python Worker Dependencies**:
   ```bash
   pip install -r workers/requirements.txt
   ```
   *(Note: OzPrint includes an automatic `pdf-lib` fallback for local development if Python packages are not installed on your host OS).*

---

## 2. Development Workflow

- **Start the Backend Server (`apps/server`) in Watch Mode**:
  ```bash
  npm run dev:server
  ```
- **Start the Frontend Vite SPA (`apps/web`)**:
  ```bash
  npm run dev:web
  ```
- **Build All Workspaces**:
  ```bash
  npm run build
  ```

---

## 3. Mandatory Release Gate Tests

Every pull request must pass all three automated test suites before merging:

```bash
# Run all suites
npm test

# Individual test suites
npm run test:unit         # Deterministic page resolver & duplex sheet math
npm run test:security     # Path traversal fuzzing, RBAC isolation & zero-shell validation
npm run test:integration  # Print job state machine, idempotency, N-Up layout & Kiosk purge
```

---

## 4. Coding & Security Standards

- **TypeScript Strictness**: All workspaces extend [`tsconfig.base.json`](tsconfig.base.json) with `"strict": true`.
- **Zero-Shell Subprocess Execution**: Never invoke `child_process.exec` or `spawn` with `shell: true`. Use `runSafeBinary()` in [`apps/server/src/security/sandbox.ts`](apps/server/src/security/sandbox.ts).
- **Opaque File Addressing**: Never pass raw filenames in URLs or use `original_filename` as a disk path. Always address documents by their `UUIDv4` `docId` and resolve disk paths through `resolveSafeStoragePath()`.
- **Commit Messages**: Use clear, descriptive commit messages (e.g., `feat(slicer): add 16-up page layout support`, `fix(cups): handle lpstat paper jam output`).

---

## 5. License

By contributing to OzPrint, you agree that your contributions will be licensed under the [MIT License](LICENSE).
