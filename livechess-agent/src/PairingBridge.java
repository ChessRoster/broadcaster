import com.fasterxml.jackson.databind.*;
import com.novotea.chess.util.service.ServiceAccess;
import com.novotea.livechess.api.*;
import com.novotea.livechess.api.model.*;
import com.novotea.livechess.api.services.*;
import com.novotea.livechess.operations.games.ImportPairings;
import com.sun.net.httpserver.*;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import javafx.application.Platform;

/** Version-specific adapter. Every model access happens on the JavaFX thread. */
public final class PairingBridge {

  private static final ObjectMapper JSON = new ObjectMapper();
  private static String token, version;
  private static long build;
  private static File receipts;

  private static final class Failure extends RuntimeException {

    final int status;

    Failure(int status, String message) {
      super(message);
      this.status = status;
    }
  }

  public static void start(String options) throws Exception {
    ServiceAccess.get(TournamentService.class).list();
    LiveChessRelease release = ServiceAccess.get(LiveChessRelease.class);
    version = release.getVersion();
    build = release.getBuild();
    if (
      !(("2.2".equals(version) && build == 18071800L) || ("2.2.11".equals(version) && build == 26052800L))
    ) throw new IllegalStateException(
      "Unsupported LiveChess build " + release.getVersion() + "/" + release.getBuild() + "; pairing adapter disabled"
    );
    String[] opt = options.split(",", 2);
    if (opt.length != 2) throw new IllegalArgumentException("Invalid agent options");
    String credential = opt[1];
    if (credential.startsWith("@")) {
      Path tokenPath = Paths.get(credential.substring(1));
      if (
        !tokenPath.isAbsolute() || !Files.isRegularFile(tokenPath) || Files.size(tokenPath) > 512
      ) throw new IllegalArgumentException("Invalid agent token file");
      credential = new String(Files.readAllBytes(tokenPath), StandardCharsets.UTF_8).trim();
    }
    if (!credential.matches("[A-Za-z0-9_-]{32,256}")) throw new IllegalArgumentException("Invalid agent token");
    token = credential;
    receipts = ServiceAccess.get(PersistencyService.class).directory("broadcaster-pairing-receipts");
    Files.createDirectories(receipts.toPath());
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.parseInt(opt[0])), 8);
    server.createContext("/", PairingBridge::handle);
    server.setExecutor(
      Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "Broadcaster pairing HTTP");
        t.setDaemon(true);
        return t;
      })
    );
    server.start();
  }

  private static void handle(HttpExchange e) throws IOException {
    int status = 200;
    Object result;
    FutureTask<Object> task = null;
    try {
      String query = e.getRequestURI().getRawQuery();
      final String nonce = e.getRequestMethod().equals("GET") &&
        e.getRequestURI().getPath().equals("/health") &&
        query != null &&
        query.matches("nonce=[0-9a-f]{64}")
        ? query.substring(6)
        : null;
      String auth = e.getRequestHeaders().getFirst("Authorization");
      if (
        nonce == null &&
        (auth == null ||
          !MessageDigest.isEqual(
            ("Bearer " + token).getBytes(StandardCharsets.UTF_8),
            auth.getBytes(StandardCharsets.UTF_8)
          ))
      ) throw new Failure(401, "Unauthorized");
      if (e.getRequestHeaders().getFirst("Origin") != null) throw new Failure(403, "Browser requests are not accepted");
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int n;
      while ((n = e.getRequestBody().read(buffer)) != -1) {
        bytes.write(buffer, 0, n);
        if (bytes.size() > 1048576) throw new Failure(413, "Request exceeds 1 MiB");
      }
      final byte[] body = bytes.toByteArray();
      task = new FutureTask<Object>(() ->
        nonce != null ? health(nonce) : dispatch(e.getRequestMethod(), e.getRequestURI().getPath(), body)
      );
      Platform.runLater(task);
      result = task.get(30, TimeUnit.SECONDS);
    } catch (Throwable ex) {
      Throwable cause = ex;
      while (cause.getCause() != null) cause = cause.getCause();
      if (ex instanceof TimeoutException) {
        if (task != null) task.cancel(false);
        status = 503;
        result = Collections.singletonMap("error", "LiveChess is busy; retry the same requestId to reconcile");
      } else {
        status = cause instanceof Failure ? ((Failure) cause).status : 400;
        result = Collections.singletonMap(
          "error",
          cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage()
        );
      }
    }
    byte[] out = JSON.writeValueAsBytes(result);
    e.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    e.getResponseHeaders().set("Cache-Control", "no-store");
    try {
      e.sendResponseHeaders(status, out.length);
      e.getResponseBody().write(out);
    } finally {
      e.close();
    }
  }

  private static Object dispatch(String method, String path, byte[] body) throws Exception {
    TournamentService service = ServiceAccess.get(TournamentService.class);
    if (method.equals("GET") && path.equals("/health")) return health(null);
    if (method.equals("GET") && path.equals("/tournaments")) {
      List<Object> list = new ArrayList<>();
      for (Tournament t : service.list()) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", t.entityUUID().toString());
        m.put("name", t.getName());
        m.put("rounds", t.getRounds().size());
        list.add(m);
      }
      return list;
    }
    if (!method.equals("POST") || !path.equals("/pairings")) throw new Failure(404, "Unknown endpoint");
    JsonNode input = JSON.readTree(body);
    if (input == null || !input.isObject()) throw new Failure(400, "Expected JSON object");
    String id = text(input, "tournamentId"),
      requestId = text(input, "requestId"),
      pgn = text(input, "pgn");
    if (!requestId.matches("[A-Za-z0-9_-]{1,128}")) throw new Failure(400, "Invalid requestId");
    JsonNode rn = input.get("roundNumber");
    if (rn == null || !rn.isIntegralNumber() || !rn.canConvertToInt()) throw new Failure(400, "Invalid roundNumber");
    int nr = rn.intValue();
    if (nr < 1 || nr > 1000) throw new Failure(400, "Invalid roundNumber");
    Tournament t = service.getTournament(UUID.fromString(id));
    if (t == null) throw new Failure(400, "Unknown tournament");
    if (nr > t.getRounds().size() + 1) throw new Failure(409, "Only existing rounds or the next round are accepted");
    // Reject lossy FileReader transcoding before validating/importing.
    if (!Charset.defaultCharset().newEncoder().canEncode(pgn)) throw new Failure(
      400,
      "Names cannot be represented by the LiveChess JVM charset; launch with -Dfile.encoding=UTF-8"
    );
    Collection<Pairing> parsed = parse(t, pgn);
    String fingerprint = fingerprint(parsed);
    File receipt = new File(receipts, requestId + ".json");
    JsonNode prior = receipt.exists() ? JSON.readTree(receipt) : null;
    if (
      prior != null &&
      (!id.equals(prior.path("tournamentId").asText()) ||
        nr != prior.path("roundNumber").asInt() ||
        !fingerprint.equals(prior.path("fingerprint").asText()))
    ) throw new Failure(409, "requestId was already used for different pairings");
    Round round = nr <= t.getRounds().size() ? t.getRounds().get(nr - 1) : null;
    if (round != null && !round.getPairings().isEmpty()) {
      if (prior == null || !fingerprint.equals(fingerprint(round.getPairings()))) throw new Failure(
        409,
        "Refusing to modify a populated round"
      );
      Map<String, Object> response = response(
        "already_imported",
        requestId,
        t,
        nr,
        fingerprint,
        prior.path("backup").asText(),
        round
      );
      flushTournament(service, t, nr, fingerprint);
      Map<String, Object> committed = new LinkedHashMap<>(response);
      committed.put("status", "imported");
      writeReceipt(receipt, committed);
      return response;
    }
    // A committed receipt with no actual pairing state must not silently recreate a cleared round.
    if (prior != null && !prior.path("status").asText().equals("pending")) throw new Failure(
      409,
      "Previously imported round is now empty; manual reconciliation required"
    );
    File backups = ServiceAccess.get(PersistencyService.class).directory("broadcaster-pairing-backups");
    Files.createDirectories(backups.toPath());
    String backupName = t.entityUUID() + "-" + UUID.randomUUID();
    ServiceAccess.get(LiveChessCore.class).write(backups, backupName, t);
    String backup = new File(backups, backupName + ".json").getAbsolutePath();
    Map<String, Object> intent = new LinkedHashMap<>();
    intent.put("status", "pending");
    intent.put("requestId", requestId);
    intent.put("tournamentId", id);
    intent.put("roundNumber", nr);
    intent.put("fingerprint", fingerprint);
    intent.put("backup", backup);
    writeReceipt(receipt, intent);
    if (round == null) {
      round = Round.newInstance();
      service.addRounds(t, Collections.singleton(round));
    }
    File file = File.createTempFile("broadcaster-pairings-", ".pgn");
    try {
      try (Writer writer = new FileWriter(file)) {
        writer.write(pgn);
      }
      ImportPairings operation = new ImportPairings(round);
      Field field = ImportPairings.class.getDeclaredField("file");
      field.setAccessible(true);
      field.set(operation, file);
      APIOperation.Report report = operation.execute();
      if (report.getStatus() != APIOperation.Status.OK) throw new Failure(
        409,
        "LiveChess importer failed; inspect backup before retrying"
      );
      if (!fingerprint.equals(fingerprint(round.getPairings()))) throw new Failure(
        409,
        "Imported pairing identity differs; manual reconciliation required"
      );
      flushTournament(service, t, nr, fingerprint);
      Map<String, Object> response = response("imported", requestId, t, nr, fingerprint, backup, round);
      writeReceipt(receipt, response);
      return response;
    } finally {
      file.delete();
    }
  }

  private static String text(JsonNode node, String key) {
    JsonNode v = node.get(key);
    if (v == null || !v.isTextual() || v.asText().trim().isEmpty()) throw new Failure(400, "Missing " + key);
    return v.asText();
  }

  private static Object health(String nonce) throws Exception {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("ready", true);
    m.put("supported", true);
    m.put("version", version);
    m.put("build", build);
    m.put("protocolVersion", 1);
    if (nonce != null) {
      javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
      mac.init(new javax.crypto.spec.SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      StringBuilder hex = new StringBuilder();
      for (byte b : mac.doFinal(nonce.getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x", b & 255));
      m.put("serverProof", hex.toString());
    }
    return m;
  }

  @SuppressWarnings("unchecked")
  private static Collection<Pairing> parse(Tournament t, String pgn) throws Exception {
    Class<?> cls = Class.forName("com.novotea.livechess.operations.games.PGNPairingBuilder");
    Constructor<?> ctor = cls.getDeclaredConstructor(Tournament.class);
    ctor.setAccessible(true);
    be.jadou.pgn.PGNVisitor builder = (be.jadou.pgn.PGNVisitor) ctor.newInstance(t);
    // Parser otherwise accepts trailing tags without a result; track that explicitly.
    final boolean[] dirty = { false };
    final int[] games = { 0 };
    final Set<String> tags = new HashSet<>();
    be.jadou.pgn.PGNVisitor validator = (be.jadou.pgn.PGNVisitor) java.lang.reflect.Proxy.newProxyInstance(
      cls.getClassLoader(),
      new Class<?>[] { be.jadou.pgn.PGNVisitor.class },
      (proxy, method, args) -> {
        String name = method.getName();
        if (name.equals("tag")) {
          dirty[0] = true;
          if ("FEN".equals(args[0]) || ("SetUp".equals(args[0]) && !"0".equals(args[1]))) throw new Failure(
            400,
            "Custom starting positions are unsupported"
          );
          if (!tags.add((String) args[0])) throw new Failure(400, "Duplicate PGN tag");
        }
        if (name.equals("move") || name.equals("movenr") || name.equals("beginVariation")) throw new Failure(
          400,
          "Pairing PGN must contain no moves or variations"
        );
        if (name.equals("result")) {
          if (!"*".equals(args[0]) || !tags.contains("White") || !tags.contains("Black")) throw new Failure(
            400,
            "Pairings require White, Black and unfinished result"
          );
          games[0]++;
          dirty[0] = false;
          tags.clear();
        }
        return method.invoke(builder, args);
      }
    );
    be.jadou.pgn.parser.PGNParser parser = new be.jadou.pgn.parser.PGNParser(new StringReader(pgn));
    while (parser.parse(validator)) {}
    if (dirty[0] || games[0] == 0 || games[0] > 500) throw new Failure(400, "Incomplete or empty pairing PGN");
    Method get = cls.getDeclaredMethod("getPairings");
    get.setAccessible(true);
    Collection<Pairing> pairings = (Collection<Pairing>) get.invoke(builder);
    Set<String> players = new HashSet<>();
    for (Pairing p : pairings) {
      String w = player(p.getWhite()),
        b = player(p.getBlack());
      if (!players.add(w) || !players.add(b)) throw new Failure(
        400,
        "A player appears on multiple boards or plays themselves"
      );
    }
    if (pairings.size() != games[0]) throw new Failure(400, "PGN game count differs");
    return pairings;
  }

  private static String player(Player p) {
    String s = p == null ? null : com.novotea.livechess.api.pgn.PGNModelWriter.player(p);
    if (
      s == null ||
      s.trim().isEmpty() ||
      "?".equals(s.trim()) ||
      s.length() > 300 ||
      s.chars().anyMatch(c -> Character.isISOControl(c))
    ) throw new Failure(400, "Invalid player name");
    return s;
  }

  private static String fingerprint(Collection<Pairing> pairings) throws Exception {
    List<Object> rows = new ArrayList<>();
    int board = 1;
    for (Pairing p : pairings) rows.add(Arrays.asList(board++, player(p.getWhite()), player(p.getBlack())));
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(rows));
    StringBuilder hex = new StringBuilder();
    for (byte b : digest) hex.append(String.format("%02x", b & 255));
    return hex.toString();
  }

  private static Map<String, Object> response(
    String status,
    String requestId,
    Tournament t,
    int nr,
    String fp,
    String backup,
    Round r
  ) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("status", status);
    m.put("requestId", requestId);
    m.put("tournamentId", t.entityUUID().toString());
    m.put("roundNumber", nr);
    m.put("count", r.getPairings().size());
    m.put("fingerprint", fp);
    m.put("backup", backup);
    List<Object> rows = new ArrayList<>();
    int board = 1;
    for (Pairing p : r.getPairings()) {
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("board", board++);
      row.put("white", player(p.getWhite()));
      row.put("black", player(p.getBlack()));
      rows.add(row);
    }
    m.put("pairings", rows);
    return m;
  }

  private static void flushTournament(TournamentService service, Tournament t, int nr, String expectedFingerprint)
    throws Exception {
    // Invoke the existing store's transactional writer, preserving its dispatcher/locking.
    Field store = service.getClass().getDeclaredField("store");
    store.setAccessible(true);
    IndexFile<?> index = ((IndexStore<Tournament>) store.get(service)).index(t);
    Method persist = index.getClass().getMethod("persist", com.novotea.chess.util.task.TaskInfo.class);
    persist.invoke(index, new Object[] { null });
    Tournament disk = ServiceAccess.get(LiveChessCore.class).read(index.getDirectory(), "index");
    if (disk == null || disk.getRounds().size() != t.getRounds().size()) throw new Failure(
      409,
      "Tournament persistence verification failed"
    );
    if (!expectedFingerprint.equals(fingerprint(disk.getRounds().get(nr - 1).getPairings()))) throw new Failure(
      409,
      "Tournament persistence verification failed"
    );
  }

  private static void writeReceipt(File target, Object value) throws IOException {
    Path temp = Files.createTempFile(receipts.toPath(), "receipt-", ".tmp");
    try {
      try (FileOutputStream out = new FileOutputStream(temp.toFile())) {
        out.write(JSON.writeValueAsBytes(value));
        out.getFD().sync();
      }
      Files.move(temp, target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(temp);
    }
  }
}
