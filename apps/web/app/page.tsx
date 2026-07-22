import {
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";

export default function Home() {
  return (
    <Container component="main" size="sm" py="xl">
      <Stack gap="lg">
        <Badge variant="light">Next.js + Mantine</Badge>
        <Stack gap="xs">
          <Title order={1}>Your application is ready.</Title>
          <Text c="dimmed" size="lg">
            Start by editing <Code>app/page.tsx</Code>. Mantine is configured as
            the default component system, including server-rendered color
            schemes.
          </Text>
        </Stack>
        <Card withBorder padding="lg" radius="md">
          <Stack gap="md">
            <Title order={2} size="h3">
              Build from accessible components
            </Title>
            <Text>
              Use Mantine components directly and add product-specific
              components to the shared UI package when reuse is justified.
            </Text>
            <Group>
              <Button
                component="a"
                href="https://mantine.dev/core/package/"
                rel="noreferrer"
                target="_blank"
              >
                Browse components
              </Button>
              <Anchor href="https://nextjs.org/docs" target="_blank">
                Read the Next.js documentation
              </Anchor>
            </Group>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
