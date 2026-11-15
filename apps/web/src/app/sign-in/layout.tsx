import { CenteredColumn, CenteredPage } from "@/components/centered-page";

export default function SignInLayout({ children }: LayoutProps<"/sign-in">) {
  return (
    <CenteredPage>
      <CenteredColumn>
        <p className="text-title">Watchdog</p>
        {children}
      </CenteredColumn>
    </CenteredPage>
  );
}
