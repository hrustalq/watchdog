export default function SignInLayout({ children }: LayoutProps<"/sign-in">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-title">Watchdog</p>
        {children}
      </div>
    </main>
  );
}
