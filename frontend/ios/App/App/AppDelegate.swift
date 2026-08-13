import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Save shared application state here if needed.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = CAPBridgeViewController()
        window.makeKeyAndVisible()
        self.window = window

        // With the scene lifecycle, cold-start URLs and Universal Links arrive in
        // connectionOptions instead of UIApplicationDelegate. Forward them only
        // after the Capacitor bridge has been attached to the window.
        DispatchQueue.main.async {
            for urlContext in connectionOptions.urlContexts {
                _ = ApplicationDelegateProxy.shared.application(
                    UIApplication.shared,
                    open: urlContext.url,
                    options: [:]
                )
            }

            for userActivity in connectionOptions.userActivities {
                _ = ApplicationDelegateProxy.shared.application(
                    UIApplication.shared,
                    continue: userActivity,
                    restorationHandler: { _ in }
                )
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for urlContext in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: urlContext.url,
                options: [:]
            )
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
