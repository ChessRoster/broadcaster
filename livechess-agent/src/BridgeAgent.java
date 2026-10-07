import java.lang.instrument.Instrumentation;
import java.net.URLClassLoader;

public class BridgeAgent {

  public static void premain(String options, Instrumentation instrumentation) {
    Thread thread = new Thread(
      () -> {
        for (int attempt = 0; attempt < 120; attempt++) {
          try {
            for (Class<?> c : instrumentation.getAllLoadedClasses()) {
              if (c.getName().equals("com.novotea.livechess.service.tournament.DefaultTournamentService")) {
                URLClassLoader loader = new URLClassLoader(
                  new java.net.URL[] { BridgeAgent.class.getProtectionDomain().getCodeSource().getLocation() },
                  c.getClassLoader()
                ) {
                  protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
                    if ((name.equals("PairingBridge") || name.startsWith("PairingBridge$"))) {
                      Class<?> found = findLoadedClass(name);
                      if (found == null) found = findClass(name);
                      if (resolve) resolveClass(found);
                      return found;
                    }
                    return super.loadClass(name, resolve);
                  }
                };
                loader.loadClass("PairingBridge").getMethod("start", String.class).invoke(null, options);
                return;
              }
            }
          } catch (Throwable e) {
            e.printStackTrace();
          }
          try {
            Thread.sleep(1000);
          } catch (InterruptedException e) {
            return;
          }
        }
        System.err.println("Pairing bridge startup timed out");
      },
      "Pairing bridge bootstrap"
    );
    thread.setDaemon(true);
    thread.start();
  }
}
